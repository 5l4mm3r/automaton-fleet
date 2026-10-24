# Candidate fleet/integration-v2.6 (24 Oct 2026): Anthropic reasoning restored, local-run fixes kept

**Owner instruction, 24 Oct 2026:** resume the original arrangement: the VM for development, the existing VPS for unattended
runtime, the Anthropic API for reasoning (the owner's Max-included API credits), and Fleet's library and local tools for
storage and execution. No subscription-authentication adapter, no further Qwen-specific launch work. This record covers
local integration and preparation only. Nothing has been pushed, deployed, restored, or paid for.

## Final candidate (frozen 24 Oct; awaiting Group A confirmation for this exact code)

**Code: 03ba290** on `fleet/integration-v2.6`. The frozen head is the docs-only commit on top of it, which adds this record.
Schema 111 → **115**. Release evidence on 03ba290: 22 focused files, **22/22, 234/234 tests, runner exit 0, no unhandled
errors**, sequential, quiet machine, deadlines unchanged.

How it got here, after the owner's authorisation of Group A for "the candidate frozen after the L2 repair":
- **0d76e35:** the L2 fixture repair. It passed the release checks cleanly (22/22, 233/233, exit 0). Group A was
  authorised for it.
- **Found before running Group A:** the VPS revision rehearsal would fail on 0d76e35 by design. Its scripted founder
  never classifies the buyer's report (v115), and its check 4d expects the redelivery to settle the request. Under v113,
  a delivery answered a request only with a passing visible-phrase check, so a phrase-free correction could never settle
  it. That contradicts the owner's refinement that phrase matching is one verification method, not the only one.
- **03ba290:** a delivery that fulfils an established correction also answers the request (v115). The rehearsal's
  founder classifies the report as a correction, and check 4a expects v115's wording. Regression added.
- **So Group A was not started.** The candidate changed after the authorisation, and that needs the owner's word for
  03ba290.

## Production baseline (read 2026-10-24 12:51Z, read-only)

| Item | Value | Source |
|---|---|---|
| Runtime | 89d7c21be73641f08fd99cbb35abb21f0e91af6e, build 6876e356…66c0, lockfile 1df54e35…21c1 (approved = pinned = Operator API release) | operator API `fleet_runtime_verification` |
| Schema | **v111** (v112 has never run on production) | `fleet_status` |
| Fleet | cap 2, 2 living, DEVELOPMENT, replication off; all four safety flags false | `fleet_status` |
| Agents | founder-1 on 89d7c21, agent-2 on b60e262, both paused by the owner (since 2026-10-10) | `fleet_list_agents`, resume record |
| Inference | **contained since 2026-10-23 14:26Z**: cognition policy disabled, controller `FLEET_COGNITION_PROVIDER=none`, Anthropic key in `/etc/automaton-fleet/recovery/` (root-only, not read here) | docs/operations/local-machine.md |
| Fleet AI-credit ledger | 1,676,179,930 µ¢ ($16.76) after plan C; held 0 | candidate-cf86ab8.md |

## Histories

- `fleet/final-v2.5` contains all of `fleet/final-v2.4`; the remote has `fleet/final-v2.5` at 51a1f82.
- VM, not pushed: **8077f6c**: a call-rate refusal rests the founder 60 s.
- Desktop (WSL, RTX 5080), not pushed and **not yet on the VM**: 9409e8a, 26769cb, 75e68c6, c7df423, 90b5782, built on
  51a1f82 and without 8077f6c. They hold the tool-argument repairs, the false-delivery guard, the inspector checks
  (`text_off_page`, `text_overlap`, `pdf_content`), procedure cleanup and full delivery evidence.
- **Transfer done (24 Oct).** `C:\Users\o\Documents\fleet-desktop-preserve-20261024\` was mounted read-only at
  `/mnt/fleetpreserve`.
  - All 14 entries of its own `SHA256SUMS` were verified: the bundle, the evidence archive, 11 patches and `commits.txt`.
  - The package was copied unchanged to `~/fleet-desktop-preserve-20261024/` on the VM, and the evidence extracted under
    `evidence/`.
  - The bundle verified (it requires 51a1f82) and was fetched as `refs/desktop/final-v2.5` = **c6e3d85**: 11 commits,
    9409e8a … f9db421, 8da6a94, f893ddf, **b9d9bd1 (v113)**, c6e3d85.
  - The VM's `fleet/final-v2.5` (8077f6c) and this branch's commits are untouched. The desktop history is **merged**,
    not rebased.
- **The desktop did not change v112.** It added **v113**: an order's *effective* delivery is its first, or one whose files
  differ from the previous sent delivery and whose review passed `required_content`. A byte-identical resend now answers
  no request (run 6). v113 keeps `order_message {resolved:true}` as a resolution, so the bypass below survives v113.
- This branch: `fleet/integration-v2.6` from 8077f6c. The desktop commits will be **merged** in, so neither history is
  rewritten (see "Remaining before approval").

## Changes in this candidate

1. **v112 no longer changes a provider on upgrade.** Migration order: production v111 → **v112 (amended)** → **v113 (the
   desktop's, unchanged)**.
   - **Executed:** the original v112 was executed in temporary registries, on the desktop (its test and scenario runs)
     and on this VM (the 2B diagnostic and tests of 23 Oct).
   - **Retained:** temporary clusters are meant to be deleted when their test stops (`fixtures/ephemeral-pg.ts`), but a
     killed or interrupted run leaves one. This VM has **5 retained clusters still running** from 22–23 Oct, none from
     the 24 Oct test run: `/tmp/fleet-pg-stmhSA` v110, `-098wZO` v111, `-mpljJP` v61, `-OqoHcF` v72, and
     **`-pceRV5` v112 with the original's `local_only`** (started 23 Oct 15:47).
   - **Missing:** the desktop's inventory (`/tmp/fleet-pg-*` and any system cluster with its versions). It is not in the
     package, so the desktop may hold similar clusters.
   - **Historical, excluded:** every cluster that ran the original v112 is a **historical test environment**. Each is
     preserved as it is, never upgraded, and **excluded from deployment and rehearsal inputs**. The production rehearsal
     (`fleet-rollout.sh rehearse`) uses a fresh read-only dump of the live database, so it is production-equivalent and
     independent of those clusters. The missing desktop inventory does not block it.
   - **Decision and evidence:** production is at v111 (operator API, read 24 Oct) and has never applied v112. No
     registry that ran the original is a registry of value: each is a throwaway test or scenario database, created per
     run with fake or local providers. So production receives the **amended** v112, then v113. Because the runner
     records versions, not contents, any retained cluster that ran the original keeps it. Such clusters are test data,
     never migrated forward as if equivalent. Stopping or deleting them is the owner's decision; none was touched. As first written, v112 made every registry `local_only` and disabled its
   enabled cloud tiers and policy as it ran. Now:
   - a registry with an enabled cloud tier or cloud policy is recorded `cloud_allowed`, and its configuration is kept;
   - any other registry is `local_only`, and cloud requires the owner's recorded `inference-profile-set`. That includes
     the contained production registry, unless its tiers are still enabled; the pre-deploy snapshot settles which.

   The trigger guard and the owner function are unchanged. Returning to `local_only` still disables cloud tiers and policy.
   The controller's own gate is unchanged: `FLEET_INFERENCE_PROFILE` defaults to `local_only`, and the controller refuses
   to start with a cloud provider unless runtime.env sets `cloud_allowed`. That is a loud, explicit deployment setting,
   never a silent switch.
2. **The hourly call limit: three implementations reconciled into one.**

   | | 8077f6c (VM) | f9db421 (desktop) | v112 eligibility time (this branch) |
   |---|---|---|---|
   | Rest after an hourly-bound refusal | fixed 60 s | from the founder's own call times (+2 s); unknown → 60 s doubling; 30 s–10 min | **FleetController's** time: when enough of the last hour's calls leave the window (counts every call, survives restarts) |
   | Before calling | — | status `turnsLastHour ≥ maxTurnsPerHour` → rest, no refused call | — |
   | Provider / service rate limit | 60 s | 60 s | the controller's Retry-After when given, else 60 s |
   | Tests | work-continuity 1r | fleet-founder-hourly-bound (desktop) | v112-pg eligibility, client Retry-After, work-continuity 1s |

   **Combined:**
   - f9db421's check before calling and its call-time estimate are kept;
   - on a refusal, `restForHourlyBound` takes the controller's `retryAfterS` first, as one rest of at most 10 minutes
     (the status is read again after it), and otherwise falls back to f9db421's estimate and backoff;
   - 8077f6c's fixed minute survives only as the rate-limit fallback, and its `REST_CODES` is removed.

   All three implementations' tests run against the combined code.
3. **Kept from the local-model work, provider-neutral:**
   - durable `deliveryOwed`, and `revisionOwed` after a delivery;
   - an obligation-first wake brief;
   - the `/workspace` path alias;
   - source-aware repetition protection: refusals persist and are fingerprinted against the files, capabilities and runtime
     they depend on;
   - parameterised procedures;
   - the 15-minute owed recheck;
   - stale-review protection;
   - evidence of workspace files.

   The compact tool list stays local-provider only; cloud tiers keep the full tool documentation, prompt caching
   per tier, and the approved routing and budgets, all untouched.

4. **No automatic production database restore, in the repository.** The 89d7c21 install relied on a hand-edited kit
   (~/rlc130). `scripts/fleet-rollout.sh` now refuses to restore by default:
   - a failed cutover past the migration point stops the controller-side units and restores nothing (exit 2);
   - `revert` refuses (exit 3);
   - restoring needs the owner's explicit `FLEET_ROLLOUT_AUTO_RESTORE=1` for that run;
   - a failure before the migration still restores runtime.env and the release, with no database touched.

## Correction obligation: acknowledging and fulfilling separated (v114, implemented)

> **Superseded by v115 (implemented 24 Oct, owner-approved design with refinements; see the next section).** Kept for the record:
> **Temporary limitation; not the finished policy, and not to be installed in production (owner, 24 Oct).** v114 treats
> every post-delivery buyer message as correction work, which moves routine customer handling ("thanks") onto the owner.
> The replacement, separating unread messages, conversation and established corrections with acceptance criteria, is
> designed in [`docs/design/customer-message-handling.md`](../../design/customer-message-handling.md) and awaits approval.
> It would be a migration on top of v114, so pushed history is never edited, and production would go 111 → that version in
> one install.

**The bypass is closed.** Until v113, `order_message {resolved:true}` after a buyer's request ended the owed revision and
closed the conversation 7 days later with no new file. v114 (`migrations-phase114.ts`, restating v113's functions and v108's
closure):
- `resolved:true` **acknowledges** the conversation: no reply is owed, and the state is `acknowledged`.
- A buyer's request after the order's latest effective delivery (v113) stays **owed** until one of:
  - **verified fulfilment:** a later effective delivery, meaning changed files whose review passed `required_content`
    (v113);
  - **the order's end:** refunded, reversed or cancelled;
  - **a genuine buyer withdrawal:** the buyer's **own message** on that order, written since the request began, recorded
    by the **owner** (`fleet_admin_order_correction_withdrawn`, CLI `economy-order-correction-withdrawn <orderId>
    <buyerMessageId> <reason>`). An operator actor is required, the agent role cannot execute it, an agent's message is
    refused, and each withdrawal is an immutable row plus a permanent `order_correction_withdrawn` event. There is no
    agent-quoted withdrawal.
- A buyer message after a withdrawal is a new request.
- While a correction is owed, the order conversation does not close as "resolved".
- **Agent-facing:** the brief now says `resolved:true` only acknowledges. A `resolved:true` answer while a correction is
  owed returns "ACKNOWLEDGED, NOT FULFILLED".
- **Cost bound** (`mind.ts`): an owed item re-wakes the agent for a recheck. While the only owed work is acknowledged,
  unchanged corrections, the recheck backs off (15, 30, 60 minutes … at most 24 hours), so one unanswered "thanks!" no
  longer means a paid wake every 15 minutes until the owner acts. A new buyer message, an unanswered message or a first
  delivery owed keeps or resets 15 minutes. The obligation never leaves the packet.

**Policy consequence for the owner.** FleetController does not classify a buyer's words. Every buyer message after a
delivery (a question, a "thanks!") is treated as a request. It ends only by redelivery, refund or cancellation, or the
owner recording the buyer's withdrawal. So "thanks"-type messages need the owner's one-line withdrawal, which is visible
in Fleet Command's events.

**Focused regression:**
- `fleet-v100-obligations-pg`, the new v114 test:
  - the bypass: `resolved:true` with no delivery leaves the request acknowledged and owed, `order.thread` reports it,
    and the conversation stays open past 7 days;
  - the agent role is denied the owner function, and a non-operator actor is refused;
  - an agent's message is refused as a withdrawal;
  - a genuine withdrawal clears it, with its event and immutable history;
  - a new buyer message reopens it, and a refund ends it.
- The two earlier tests that asserted the bypass now assert the separation (marked v114).
- `work-continuity` 1t (recheck backoff and reset; first delivery never backed off) and 1u (the "ACKNOWLEDGED, NOT
  FULFILLED" reply and the brief's wording).

## Customer messages: conversation and correction separated (v115, implemented)

Owner-approved design ([`docs/design/customer-message-handling.md`](../../design/customer-message-handling.md)), with the
three refinements:
- **The agent classifies** each post-delivery buyer message (`customers order_classify`): conversation, correction (with
  outcome criteria), or unclear (ask the buyer). Each decision is recorded immutably with its source message and reason.
- **Fleet Control checks** a "conversation" once (`MessageChecker`, the controller's worker), recording verdict,
  confidence and evidence. It runs within the existing daily ceiling. When the review is unavailable, the message is
  checkpointed and deferred.
- **An established correction** is owed until a delivery of changed files whose passing review lists every outcome as met,
  a refund or cancellation, a Fleet Control-confirmed buyer withdrawal (`withdraw_correction`), or the owner's override.
  `resolved:true` never closes it.
- **A genuine "thanks"** completes without owner action: classified conversation → answered with `resolved:true` →
  Fleet Control confirms "no_change". An unconfirmed or uncertain check returns the message to the agent.

**Focused regression** (`fleet-v100-obligations-pg`, 7 v115 cases): thanks and a question with no owner action and no
repeated check; an explicit layout correction with no phrase, which `resolved:true` cannot close, fulfilled by a review
listing its outcome; an ambiguous request leading to one clarifying question and the reply classified afresh; a
disputed and a low-confidence check; withdrawal at high and low confidence (not on the request itself); an unavailable
review (budget deferral is not an attempt; 3 provider failures then stalled with one event; nothing sent to the buyer);
accounting (the same legs as a knowledge review, its own reservation kind, consumption booked as Fleet Control's). The
earlier v100/v112/v113 tests now follow the v115 flow. Plus `fleet-message-check` (checker unit, 5) and the brief's
wording (`fleet-v100-customer-obligations`, 2 new).

## Fleet Control's state in production (read-only, 24 Oct)

- **Daily AI budget not set:** ceiling empty, room 0, "Fleet Control makes no paid call until the owner sets its daily AI
  budget". Review tier T2 (claude-sonnet-5-5); per-call estimate 3p (the claim gate).
- **Consequence under v115 until a budget is set:** every "conversation" classification waits for its check (deferred:
  not the agent's work, nothing asked of the buyer). Fleet Control records `fleet_control_ai_budget_reached` once a day.
  So while the budget is unset, a change wrongly classified as conversation is **not** caught. The independent check is
  the only guard on that path. Established corrections are unaffected.
- **Not changed or enabled automatically.** Setting a budget is the owner's decision (`fleet_admin_fleet_control_ai_budget`).
- **Tiers T1/T2/T3 enabled (Anthropic); cognition policy disabled** (the 23 Oct containment). The amended v112 therefore
  records `cloud_allowed` and changes nothing.

**Limits that stay visible:**
- A review listing every outcome as "met" does not by itself prove the document's quality. The S1 evaluation must still
  inspect the actual delivered original and correction.
- Confidence thresholds (0.7 / 0.8) are routing rules, not guarantees of correctness.

## Group A on 482c5d6 (24 Oct): three rehearsals passed, the revision rehearsal FAILED — stopped

Kit `~/rlc132` on the VPS.
- **Done:**
  - **pushed** `fleet/integration-v2.6` = 482c5d6 (new branch, no force);
  - **built:** pins commit 482c5d6, build e0b424c6…a78, lockfile 1df54e35… (unchanged);
  - **staged** and **installed beside** at `/opt/automaton-fleet/releases/482c5d6…` (root-owned, read-only, identity
    re-verified); `current` stayed 89d7c21.

| Rehearsal (throwaway, fake provider, no credentials) | Result |
|---|---|
| data, `fleet-rollout.sh rehearse 111 → 115` | **PASSED**: migration, reconciliation (1,117 journals), re-run applies nothing, rollback restore proved; live untouched |
| services, `fleet-upgrade-rehearsal.sh 111 → 115` | **PASSED**: every service on the copy. **89d7c21 refuses schema 115**, so a post-install rollback is class B: a database restore, owner-approved only |
| founder upgrade (89d7c21 → 482c5d6) | **PASSED**: 27/27, host clean, living founders untouched |
| revision | **FAILED**: 17/19; 4c and 4d failed (no redelivery) |

- **Why the revision rehearsal failed:** the harness, not the runtime. Its scripted founder found the open order with the
  pre-v114 wording ("answered …, not yet resolved"). Since v114 an owed correction reads "answered …; the buyer's request
  of … is still OWED". After the renderer returned it saw no open order and never delivered. The runtime's part passed
  (4b: recalculated, inspected, reviewed). The check's diagnosis was capped at 500 characters and the throwaway founder's
  logs were removed by the clean teardown, so the decisive step was found from the code, not the trace.
- **Evidence on failure (owner, before the rerun):** the rehearsal now keeps a complete evidence bundle when any check
  fails, written before teardown to a root-only directory (`FLEET_REHEARSAL_EVIDENCE_DIR`, outside everything the
  teardown removes). It holds every check in full, the model's full trace (calls with arguments and full results, last 300
  steps), its packets and commands, the founder's service log, and its non-secret state files (mind log, carried record,
  packets; never its credentials).
- **Fixed locally, not pushed:** b1eb904. `openOrderOf` accepts both wordings, and a test ties it to `obligationLines`'
  real output; 44 related tests pass. This is a new candidate: rerunning the revision rehearsal on it needs the owner's
  word.
- **Closing comparison** (read-only, 15:58Z against 14:58Z): identical release (89d7c21), schema 111, ledger head 1176 and
  verification, agents (paused; Agent-2 on b60e262), founder cognition settings, service PIDs, unit files and units,
  packages and tools. **Canonical events 329, same digest.** All settings groups identical (policy, tiers, routing,
  founder budgets, Fleet Control budget, review policy, credit lots, balance 1,676,179,930 µ¢, holds). Only the live
  database exists (the throwaway copies were dropped). No temporary units remain.
- **Event counts:** the 3,898 / 3,899 / 3,892 readings are the same scope (`count(*)` of `fleet_events`) at different
  moments. The paused agents' runtimes renew their controller sessions every ~10 minutes, and each renewal writes a
  temporary `session_opened` event that retention purges. One landed 4 s after the 14:58:53Z baseline. The canonical
  (non-expiring) history did not change.

## Group A continuation on 8f6862e (24 Oct): revision rehearsal FAILED again — runtime cause found; stopped

- **Candidate:** 8f6862e = 482c5d6 + the harness repair (b1eb904) + failure evidence + docs. The diff touches the record,
  the harness test, `src/fleet/eval/revision-rehearsal-model.ts` and `src/fleet/founder/revision-rehearsal.ts` only, with
  zero lines in runtime, schema, dependencies, scripts, deployment or configuration. So the three passed rehearsals
  (data, services, founder upgrade) carry forward.
- **Pushed** (fast-forward 482c5d6..8f6862e); built 1f593e96…; staged; installed beside production at
  `/opt/automaton-fleet/releases/8f6862e…`. `current` stayed 89d7c21. Kit `~/rlc133`.
- **Revision rehearsal: 17/19, 4c and 4d failed again.** Complete evidence was kept at
  `/var/tmp/fleet-revision-rehearsal-evidence-8f6862e-20261024T162100Z` (root-only): checks, the full model trace, packets,
  commands, the founder's service log and its state files.
- **Decisive step (16:29:44Z):** the review of the corrected workbook was refused with `FLEET_REVIEW_REQUIRE_CHANGE`
  ("a review of the revision needs require: [the exact visible text that carries the change] … your criteria's met is not
  proof"). That rule is in the founder's tool layer (`toolbox.ts` review, from the desktop's run-6 fixes). It demands a
  visible phrase for every revision after a buyer's message, which conflicts with the owner's refinement (outcome criteria;
  phrases optional) and with v115's fulfilment rule. Without a review, the scripted founder slept and never redelivered.
  The harness repair was real (the founder now recognised the open order and reached the review) but not sufficient.
- **Proposed runtime change (not made; needs the owner's approval):** at review time, if the buyer's message since the
  last delivery is an established correction, require phrases only where that correction declared `mustShow`; otherwise
  accept the review and let FleetController's v115 fulfilment rule (every outcome listed as met, changed files) decide.
  If the message is still unclassified, refuse with "classify it first (customers order_classify)".
- **Closing comparison** (read-only, 16:45Z against 16:19Z): schema, ledger head and verification, agents (paused;
  Agent-2 on b60e262), founder cognition, PIDs, unit files and units, packages and tools identical. **Canonical events 329,
  same digest** (total 3,902 → 3,896 is the session-renewal churn). All settings groups identical; only the live database
  (plus the `postgres` maintenance database) exists; `current` 89d7c21.

## Efficiency proposal (evidence from saved calls; nothing changed)

**Measured, from production's saved calls (1,070 successful calls, 26 Sep – 21 Oct):**

| Calls | Average input (uncached / cache read / cache write) | Output p50 / p95 / max | Average cost a call | Share of input from cache |
|---|---|---|---|---|
| T3 `founder_work`, 94 (20–21 Oct, current policy) | 11,929 / 35,570 / 1,654 | 241 / 688 / **894** | $0.069 | 72% |
| T2 `agent_step` (agent), 563 | 14,872 / 10,257 / 849 | 109 / 307 / 2,119 | $0.035 | 40% |
| legacy (pre-routing), 408 | 5,170 / 0 / 0 | 108 / 322 / 1,129 | $0.024 | 0% |

- **No call ever stopped at its output limit** (`max_tokens`: 0 of 1,070).
- **Steps that only went to sleep:** T2 era 391 of 568 ($14.22 of $20.10); legacy 292 of 408 ($6.56); current T3 era 2 of
  94 ($0.11). That's consistent with the event-driven wakes having closed most of it, but two days is thin evidence.
- **Exact assembled step (corrects the earlier $0.53):** 48 tool definitions = 88,138 bytes and a system prompt of 17,992
  bytes on every step. The true worst-case reservation is **$1.06 on T3** (input $0.74, output $0.32) and **$0.45 on T2**.
  This uses the V2 capability set; the production agents' exact manifests may differ slightly.
- **Average T3 step cost split:** uncached input 69%, cache writes 12%, cache reads 10%, output 9%.

**Proposals (each separately approvable; Opus stays where its judgement is needed):**
1. **Output caps for bounded tasks.** Founder steps 4,000 tokens on T3 (4.5× the observed maximum) and 4,000 on T2 (1.9×
   the maximum). The worst-case reservation falls $1.06 → $0.82 (T3) and $0.45 → $0.41 (T2). Actual cost is unchanged,
   because no call has come near these. It frees reservation headroom (plan B's starvation). `stop_reason = max_tokens`
   is watched, and any hit is reported. Fleet Control caps stay (300 / 800 / 1,500 / 4,000).
2. **Local execution, no model:** already T0 for every deterministic tool. Keep event-driven hibernation and measure
   sleep-only steps over the S1 evaluation. Target: under 5% of steps.
3. **Caching:** uncached input is 69% of a T3 step's cost. If half of it were read from cache, an average step would fall
   from $0.069 to about $0.047, before the cache-write premium (500 vs 400 µ¢). Proposed: measure `prefix+tail` on T3
   during the S1 evaluation before configuring it.
4. **Fleet Control daily ceiling:** propose **100p a day**. That's at least 27 worst-case or about 236 typical message
   checks on T2, plus the occasional spend or knowledge review. **When exhausted:** no call is made; every review is
   deferred, never approved or decided; one `fleet_control_ai_budget_reached` event a day (Fleet Command); agent work
   continues; spends needing review wait; message checks defer without counting as attempts. The owner raises or keeps
   the ceiling; nothing raises it automatically.
5. **Cheaper-model routing (separate approval):** message checks on T1 Haiku halve them (worst 1.82p, typical 0.21p, against
   3.63p / 0.42p on T2). Founder steps stay on Opus (owner policy, 20 Oct).

## Owner's approval (24 Oct, evening): review-rule repair and efficiency preparation — local, not pushed

**Owner's decisions recorded:** approve the narrow runtime review-rule repair; prepare a 4,000-token founder output default
with safe cut-off handling (any higher-limit retry is a proposal, never silent); read-only analysis of the tool definitions
and uncached context. Opus stays for founder work. **Not activated:** the 100p/day Fleet Control ceiling (deferred until the
complete evaluation budget includes it; the owner notes it is shared by every review type, so it cannot guarantee a number
of message checks, and an exhausted ceiling can hold customer work), stronger caching (measure first), Haiku message checks
(deferred until quality is shown). No push, side-install, deployment, inference, credit posting or paid evaluation.

### 1. Review-rule repair (runtime, `src/fleet/founder/toolbox.ts`)

When the buyer has written since the latest sent delivery and FleetController reports v115 message work for the order
(`customer.obligations`, read at review time and again at delivery time):
- **Unclassified (or disputed) message:** the review is refused `FLEET_REVIEW_CLASSIFY_FIRST`, naming the message(s) and
  saying what to do (order_thread, then order_classify: correction with outcome criteria, conversation or unclear).
- **Established correction:** the review must list **each outcome word for word** as a criterion (`FLEET_REVIEW_OUTCOMES`
  otherwise). Visible phrases are required **only where the correction declared `mustShow`**: those phrases are added to
  the inspector's `require` whether or not the review repeats them, so they are checked on the page; none are invented
  for a layout, removal or calculation change. FleetController's v115 fulfilment rule (changed files, passing review,
  every outcome met, `required_content` where phrases were declared) is unchanged and still decides.
- **Not readable now:** refused `FLEET_REVIEW_STATE_UNKNOWN` (fail closed).
- **Delivery stays bound** to the review: the same files as the latest sent delivery are still `FLEET_REVISION_UNCHANGED`;
  a review not recorded as a revision review is `FLEET_REVISION_UNREVIEWED`; **other bytes** than the review inspected are
  `FLEET_REVISION_STALE_FILES`; a **new buyer message** since is `FLEET_REVISION_CLASSIFY_FIRST`; a **correction established
  after the review** is `FLEET_REVISION_STALE_REVIEW`.
- **Older controller** (no v115 work reported): the run-6 rule (`require` mandatory) applies unchanged.
- No SQL changed: durable correction obligations, v113's effective delivery and v114's owner withdrawal are untouched.
  The agent's tool text (`COMPACT_ESSENTIALS`) now says phrases come from the correction.

### 2. Founder output default 4,000 tokens, with safe cut-off handling

- **Controller (`routed-gateway.ts`):** every founder step (T2/T3, tool loop or question) asks for at most **4,000** output
  tokens (`FOUNDER_STEP_MAX_OUTPUT_TOKENS`); a smaller tier value stays; a `enabled:N` thinking budget keeps N + 1,024.
  T1 chores keep the tier's own value. The reservation uses the same figure, so the T3 worst case falls by 12,000 × 2,000 µ¢
  = **$0.24** a step ($1.06 → $0.82 on the 24 Oct measurement). Tier settings in the database are unchanged.
- **Cut-off reply (stop `max_tokens` / `length`): never executes a tool call.** The Anthropic parser keeps the text and
  drops (counts) every tool call and any possibly unsigned thinking, instead of failing the call. The OpenAI-compatible and
  local parsers do the same; the local parser previously could "repair" a truncated argument string into an executable
  call, and no longer can on a cut-off. The gateway drops any call that still reaches it and returns `outputLimit
  {maxTokens, cutToolCalls}`. Provider probe P8 now counts a cut-off with no tool call as contained.
- **Founder runtime (`mind.ts`):** the agent is told its reply was cut off and that nothing in it ran, and continues in
  smaller pieces, **at most twice in a row**; a third cut-off ends the turn `FLEET_OUTPUT_LIMIT`, carried like any cut-off
  turn. A runtime without this code sees a reply with no tool calls and ends its turn (still nothing executed).
- **Higher limit: proposed, not enabled.** If cut-offs are seen in S1, option: one retry of the same step at the tier's
  own limit (8,000 / 16,000), at most once a turn, recorded with its reason. It needs the owner's approval.

### 3. Tool definitions and uncached context (read-only analysis)

**Measured on the assembled definitions** (each tool serialised as sent: name, description, input schema):

| | Tools | Tool bytes | Descriptions | Schemas | System prompt |
|---|---|---|---|---|---|
| Candidate (doctrine founder-v10) | 48 | 86,922 | 61,410 | 22,809 | 17,991 |
| Production agents (founder-v6) | 38 | 58,822 | 37,612 | 19,062 | 11,880 |

(The earlier figure, 88,138, came from a different serialisation; this per-tool sum is 1.4% smaller.) The seven
largest (business, identity, wallet, fleet_capital, browser, project, customers) are 35,971 bytes, 41%.

**Tools actually called in production's 1,070 saved calls** (names per call, by task class):
- T3 `founder_work` (94 calls, the customer work) used **13 tools**: exec 45, offer 20, deliverable 20, customers 11,
  field_journal 11, wallet 8, capabilities 3, then remember_fact, sleep, list_files (2 each), economic_knowledge,
  list_goals, view_image (1 each). They are 22,524 bytes of the candidate's 86,922 (26%).
- Across all classes, 30 tools were called at least once (53,470 bytes). **18 were never called** (33,452 bytes; the
  largest: business 6,728, project 4,115, request_spend 2,907, generate_image 2,556, code 2,552). The agents were paused or
  pre-sales for most of this period, so a tool never called is **not evidence that it is unneeded**. No tool is removed.

**Where a T3 step's money goes (90 cached T3 calls, by code):** uncached input **65.2%**, cache writes 13.5%, cache reads
11.6%, output 9.7%; $0.064 a call. The stable prefix (tools and system prompt) was read from cache at **exactly 38,879
tokens** on each warm step, at 20 µ¢ a token. So the tool definitions cost little once cached; what costs is:
- **The uncached part of each step:** median 10,119 tokens (the wake packet, about 14.9 KB, plus the turn's growing tool
  results). Option: tail caching (a cache point on the conversation, not only the prefix). Measure in S1 (earlier estimate
  $0.069 → $0.047 a step before the write premium).
- **The first step of a turn runs with the cache off** (reuse is evidenced only from step 2): 4 such calls cost $0.186 each
  (45.5k uncached tokens), then step 2 writes the prefix (38,879 × 500 µ¢). Together they were $0.74 of $6.51 (11.4%).
  Option: write the prefix on step 1 of a turn expected to continue. Stronger caching: measure first, not enabled.
- **Removing 1,000 tokens from the prefix** would have saved $0.054 over these 94 calls (90 warm reads at 20 µ¢, 4 writes at
  500, 4 cold steps at 400), about 0.8% of their cost, and lowers each step's reserved worst case by $0.005 (input is
  reserved at the dearer 500 µ¢).

**Redundant or reducible material (options, nothing changed):**
1. **One 945-byte paragraph is repeated in 13 tools** (operations recorded once, `after`, uncertain outcomes): 11,364
   redundant bytes, 13% of the tool bytes. Stating it once (the system prompt or one tool) and referring to it is the
   safest cut.
2. **The compact tool list already exists** (used for local models): 26,370 bytes for the same 48 tools plus tool_help,
   70% smaller, full text on demand. Using it on Opus needs a quality comparison (real model, Group D), not assumed.
3. **Per-task subsets** (the T3 work used 13 tools): not proposed blind. The tool-call names above are the evidence base;
   a subset would need a fallback (tool_help or a "more tools" request) and a rehearsal.
4. **Byte → token ratio is not measured.** An exact token count of the definitions needs one `count_tokens` request
   (no charge, but it sends the definitions to Anthropic with the key): owner's call.

### Candidate, tests and proposed rehearsal scope

- **Candidate:** the local commit that adds this section (hash in the report; not pushed). Changed: `toolbox.ts`,
  `obligations.ts` (export only), `cognition/types.ts` (tool text, `cutToolCalls`), `anthropic.ts`, `providers.ts`,
  `local.ts`, `routed-gateway.ts`, `probe.ts`, `mind.ts`, `service/client.ts` (type), tests, this record. **No schema,
  migration, dependency, lockfile, script, unit or configuration change.**
- **Tests (targeted, local, no inference):** new `fleet-v115-revision-review` (5, sandboxed real inspector: unclassified,
  phrase-free removal, phrase-required, stale files / new message / later correction, unreadable state) and
  `fleet-output-limit` (8: three parsers, the 4,000 cap and its reservation, the gateway drop, the mind's bounded
  continuation); `fleet-v100-obligations-pg` +1 assertion (the agent's own obligations read carries the correction) — 20/20;
  run6 replay 4/4 and local-run2 12/12 (older-controller path unchanged); cognition-anthropic 13/17, routing, local, step
  budget, message check, revision model all pass. **4 `cognition-anthropic` PostgreSQL tests fail identically on unchanged
  2e07e70** (`FLEET_INFERENCE_LOCAL_ONLY`: the test controller's default inference profile is `local_only`): pre-existing,
  not hidden, not caused here.
- **Proposed rehearsal scope (Group A, needs approval):** the diff touches the controller and the founder runtime, so the
  earlier passes do not all carry forward. **Data rehearsal: carry forward** (no migration or SQL line changed).
  **Rerun:** services rehearsal (controller code changed), founder-upgrade rehearsal (runtime changed; it also exercises
  the 4,000-token request against the fake Anthropic API) and the revision rehearsal (the target). All non-billable.

## INSTALLED: 5ee36d4 in production (Groups B and C, Agent-1 only), 24 Oct 20:57–20:59Z

Approved by the owner (Groups B and C for commit 5ee36d4 / build 09d77dac…). Run: `bash ~/rlc134/install.sh`.
- **Before mutation:**
  - **Script:** the staged script matched the reviewed one in full: SHA-256
    `fe51ad15e0162cba530f4a6bc70a170a0dbc594f010c98f0316b63deafa7e4ee` (staged copy, repo file and commit b01433f).
  - **Pins:** commit, build and lockfile matched; the installed release's own build identity was `09d77dac…` / `1df54e35…`;
    the UI package sha256 was `77ce19a4…`.
  - **Production:** schema 111 on 89d7c21; both agents paused; policy off; provider none; four flags false;
    `FLEET_ROLLOUT_AUTO_RESTORE` unset. The script's own gate passed.
  - **Baseline:** `~/rlc134/baseline-pre-install-5ee36d4-20261024T205709Z`, full dump with 5,342 TOC entries. Kept;
    never restored.
- **Release:** `RELEASE 5ee36d4 DEPLOYED 20:59:08Z`, schema 115, root UI 0.26.2. **Outage 20:58:12–20:58:59Z (47 s).**
  Cutover reconciliation OK (3,810 events preserved, none purged). `runtime_approved` and `production_deployed` recorded.
- **Agent-1:** 89d7c21 → 5ee36d4, outcome **verified** (prepared 20:59:12Z, committed and verified 20:59:14Z).
  - **Upgrade ID:** `e193e75a-2185-4452-860b-f9045645c94e`.
  - **Rollback handle**, the same ID, owner gate:
    `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS e193e75a-2185-4452-860b-f9045645c94e <reason>`.
    No rollback ID exists, because no rollback has been made.
  - **Status:** registered and pinned to 5ee36d4 / 09d77dac…; new PID 2004178; paused.
- **Agent-2:** runtime b60e262, **PID 866408 before and after**, unit untouched, paused. It heartbeats to the new controller
  (last heartbeat 17 s old at 21:00:25Z).
- **Verification (script and by hand):**
  - readyz 200; `current` is 5ee36d4; schema 115; ledger verify true and **ledger head 1176 unchanged**;
  - **inference off**: policy `cognition_enabled` false, `FLEET_COGNITION_PROVIDER=none`, Fleet Control ceiling unset;
  - **tiers byte-identical** (T1 Haiku 2,000; T2 Sonnet adaptive 8,000; T3 Opus adaptive 16,000, all enabled);
  - inference profile `cloud_allowed`, set by the migration ("kept as configured");
  - `REAL_REPLICATION_ENABLED`, `REAL_PAYMENTS_ENABLED`, `OWNER_SWEEP_ENABLED` and `FLEET_DRY_RUN_CHILD` all false;
  - permissions closed; the release carries the 4,000 cap and the v115 review;
  - runtime.env pins: 5ee36d4 / 09d77dac….
- **Settings:** every group identical before and after: cognition policy, tiers, routing, founder cognition, Fleet Control
  AI, review policy, AI-credit lots, credit balance and holds. They are also identical to the Group A capture of 18:51Z.
- **History:** the 329 permanent events up to the pre-install boundary (id 10374) have the same digest
  (`6ea8ca6f…`). Two permanent events were added (the release and Agent-1's upgrade record).
- **Expected differences only:**
  - controller-side PIDs (controller, Operator API, custody, fetcher, dashboard, identity, browser) and Agent-1's PID;
  - registry runtime 5ee36d4; schema 115;
  - two `api_auth_failed` at 20:59:05Z: founders' loopback heartbeats during the restart, as usual (48 in 7 days);
  - the outside-monitor heartbeat failed once, at 20:58:33Z, during the outage (`FAIL controller dashboard operator-api`); its next run at 21:03:49Z reported `ok`, and the unit is no longer failed.
- **Not done:** no key used, no inference call, no credit entry, no model or budget change, no agent resumed, no database
  restored.

## B/C approval package for 5ee36d4 (prepared 24 Oct ~20Z; nothing installed, activated or posted)

Group A is complete and the candidate is frozen. `count_tokens` is deferred; the retired key in
`/etc/automaton-fleet/recovery/` is untouched. **This package asks for Group B (install the controller release) and Group C
for Agent-1 only (runtime 89d7c21 → 5ee36d4).** It activates nothing.

### 1. Production Opus: thinking, output limit, reservation (computed by code, production prices of 24 Oct)

Production's T3 tier: `claude-opus-5-5`, **adaptive thinking**, effort medium, tier `max_output_tokens` 16,000; prices
400 / 2,000 / 500 / 20 µ¢ a token (input / output / cache write / cache read). Adaptive thinking is counted inside
`max_tokens`. **The 7,024 exception does not apply in production**: it arises only with a fixed `enabled:N` thinking
budget (N + 1,024 for N = 6,000), and no production tier has one. It is shown for completeness.

**Maximum reservation of one founder step** (`costBoundMicro`: every input byte counted as a token at the dearer of the
input and cache-write prices, plus the whole output allowance). Input at the runtime's 40,000-byte request budget, with the
system prompt, the full tool list and 2,000 framing tokens:

| Runtime (doctrine) | Tier | Output limit sent and reserved | Input bound (tokens) | Reserved maximum |
|---|---|---|---|---|
| Agent-1 after upgrade (founder-v10, 48 tools) | T3 Opus | today 16,000 → **4,000** | 148,905 | **$1.065 (107¢) → $0.825 (83¢)** |
| same | T2 Sonnet | 8,000 → 4,000 | 148,905 | $0.452 (46¢) → $0.412 (42¢) |
| (only with `enabled:6000`, not configured) | T3 | 7,024 | 148,905 | $0.885 (89¢) |
| Agent-2 on b60e262 (founder-v6, 38 tools; stays paused) | T2 Sonnet | 8,000 → 4,000 | 114,317 | $0.366 (37¢) → $0.326 (33¢) |
| same, if a step reached T3 | T3 Opus | 16,000 → 4,000 | 114,317 | $0.892 (90¢) → $0.652 (66¢) |

Reserved amounts are rounded up to whole US cents, as authorised; the controller converts to GBP.

**Typical actual cost is far below the reserved maximum** (production's saved calls, 20–21 Oct): a T3 founder step cost
**$0.064** on average when its prefix was cached (90 calls) and **$0.186** on a turn's first, uncached step (4 calls), $0.069
overall; output p50 241, p95 688, max 894 tokens. T2 steps averaged $0.035. The reservation is a ceiling held while the
call runs, then settled to the provider's actual usage. **The 4,000 cap lowers the ceiling ($0.24 a T3 step), not the
typical bill.**

### 2. Order: both agents paused throughout; Agent-2 untouched; nothing activated

Owner-run: `ssh -t agentfleet-vps 'bash ~/rlc134/install.sh'` (script: `install-5ee36d4.sh` beside this record; staged copy
sha256 `fe51ad15e0162cba530f4a6bc70a170a0dbc594f010c98f0316b63deafa7e4ee`). Re-running after a failure continues; it never
restores anything.
0. **Gate (changes nothing):**
   - the four rehearsal logs of this build passed and are **under 24 h old**. The oldest is 18:54Z, so the install must
     start **before 25 Oct 18:54Z**, or the rehearsals must be run again (owner approval);
   - pins, UI package checksum and the release directory present;
   - **both agents paused**; Agent-2 on b60e262, Agent-1 on 89d7c21;
   - **inference off**: policy disabled, `FLEET_COGNITION_PROVIDER=none`, Fleet Control ceiling unset;
   - permissions closed; the four safety flags false; schema 111 with 89d7c21;
   - the founder unit template identical to the release's;
   - `FLEET_ROLLOUT_AUTO_RESTORE` **unset**;
   - Agent-2's PID, the tiers and all settings recorded; a fresh baseline with a full dump (TOC checked).
1. **Group B: release 89d7c21 → 5ee36d4, schema 111 → 115** (`fleet-release.sh`; UI 0.26.2 reused). The cutover takes a
   fresh verified dump, migrates, reconciles, approves the runtime and restarts the controller-side units. **No founder
   unit restarts.** v112 records the registry's existing cloud configuration as kept (`cloud_allowed`: production's tiers
   are enabled while the policy stays disabled), and **changes no tier, model or policy**.
2. **Group C, Agent-1 only:** `fleet-founders.sh upgrade-preflight`, then `upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS` from
   the new release. Agent-1's unit restarts on 5ee36d4 and stays **paused**; its `upgradeId` is recorded for rollback.
   **Agent-2 (01M4C4NXT786Q4E9725N5A15KV): runtime b60e262, unit and process unchanged** (PID checked after each step).
3. **Verification:** controller ready; both paused; Agent-2's runtime and PID unchanged; inference still off; tiers
   byte-identical to before; profile `cloud_allowed` by migration; the release carries the 4,000 cap and the v115 review;
   flags false; permissions closed; ledger verified; settings captured after.

**Not done by this package:** resuming either agent, enabling cognition, reinstating the key, setting Fleet Control's
budget, posting credit, any paid run.

**Compatibility while paused:** Agent-2 (b60e262) keeps heartbeating to the new controller, as it did across earlier
releases. **No rehearsal from b60e262 was run for this candidate** (the founder rehearsal starts from 89d7c21). Agent-2 makes
no model call while paused, so its old handling of a cut-off reply does not arise. Before Agent-2 is ever resumed: either a
non-billable `upgrade-rehearsal b60e262…` (needs approval), or its own runtime upgrade (Group C for Agent-2, separately).

### 3. Pins, verification, outage, rollback

| | Value |
|---|---|
| Release commit | `5ee36d450646402837f36562d7719a01f3a8c86f` (branch fleet/integration-v2.6) |
| Build ID | `09d77dac1bc35b0ae58ece38968ed69b1447728e82c3c2eb5f936f6bbb7fdcee` (VPS build; staged and side-installed identical) |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Schema | 111 → 115 (v112 amended, v113, v114, v115) |
| UI | 0.26.2, `ui-0.26.2-316b27b.tgz` sha256 `77ce19a4e06814b93705b5ae96c705185c91271ce335e95f1341b854f9f0585d` (unchanged, reused) |
| Agent-1 runtime | 89d7c21 → 5ee36d4 |
| Agent-2 runtime | b60e262 (unchanged) |

**Verification commands** (read-only; also run by the script):
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/readyz` → 200;
- `readlink /opt/automaton-fleet/current` → `releases/5ee36d4…`;
- `SELECT max(version) FROM fleet.fleet_schema_migrations` → 115;
- `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-status 01M3F50SH7PNX2E3GST13J52AS` → registered and
  pinned 5ee36d4, paused;
- `systemctl show -p MainPID --value automaton-fleet-founder@01M4C4NXT786Q4E9725N5A15KV.service` → the PID recorded at step 0;
- `SELECT cognition_enabled FROM fleet.fleet_cognition_policy` → f; `grep FLEET_COGNITION_PROVIDER /etc/automaton-fleet/service.env` → none;
- `SELECT fleet.fleet_control_ai_state() ->> 'ceilingMinor'` → empty (no paid Fleet Control call);
- tiers unchanged (T1 Haiku 2,000; T2 Sonnet adaptive 8,000; T3 Opus adaptive 16,000, all enabled);
- `SELECT fleet.fleet_ledger_verify() ->> 'ok'` → true; `bash ~/rlc134/baseline.sh after nodump` and `settings.sql`
  compared with the step-0 captures.

**Expected outage:** about **45 s** of controller, Operator API, custody, fetcher and dashboard restart. Measured on
recent releases: 43–46 s. The four migrations ran in seconds on the rehearsal copy. Founder units do not restart in step 1;
Agent-1's unit restarts once in step 2 (paused, no model call).

**Rollback, and its limits:**
- **Database:** 89d7c21 refuses schema 115, so once v115 is applied, **a code-only rollback is impossible**. Going back
  needs the cutover's verified pre-migration dump restored. That is **never automatic**: `FLEET_ROLLOUT_AUTO_RESTORE` stays
  unset, so if the cutover fails its revert refuses, the controller-side units are stopped (**the outage continues**) and
  **you decide**. No database is restored without your explicit approval. Once the release is up and records written after
  it exist, fix forward is the expected path (a restore would discard them).
- **Agent-1's runtime:** `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime
  01M3F50SH7PNX2E3GST13J52AS <upgradeId> <reason>` puts it back on 89d7c21 with its state, and no database restore. The
  founder rehearsal proved 89d7c21 runs against the 5ee36d4 controller, and the rollback and re-upgrade.
- **UI:** unchanged (0.26.2); the release snapshots `dashboard.env` and restores it itself if its UI step fails.
- **Agent-2:** nothing to roll back (not touched).

### 4. Before inference activation (separate, after B/C; none is done or authorised)

1. **Key organisation verification** (owner-side, Item 5 above). Confirm in the Console that the recovery key's last four
   characters belong to the organisation whose Billing shows the Max-included promotional credit. If not, a new key from
   that organisation, installed by the owner. Reinstating any key into service is itself an owner action.
2. **Promotional-credit reconciliation** (proposal above). Read G, Rp, Rb and Uc from the Console; reconcile against lot
   05f4cb13 ($16.76) and Fleet's own consumption (0 expected) by code. **The promotional lot and grant records need a
   migration not in 5ee36d4.** No posting without your word; the internal agent charge is your separate decision.
3. **Fleet Control budget:** currently unset (no paid Fleet Control call: message checks defer, reviews wait). The 100p/day
   proposal is deferred until it is part of the complete evaluation budget; the ceiling is shared by every review type, and
   exhaustion can hold customer work.
4. **Approved spending terms:** the evaluation's terms (scope, ceiling, holds), the agents' AI fuses (Agent-1 754p/20h,
   Agent-2 3000p/60h: unchanged), the inference profile and provider switch, and which agent may resume.
5. **Also outstanding:** `count_tokens` (deferred); the cap's compatibility with Agent-2 before it is resumed (above).

## Group A on 5ee36d4 (24 Oct, 18:51–19:30Z): all rehearsals PASSED; production unchanged

- **Pushed** fast-forward 8f6862e..5ee36d4 (fleet/integration-v2.6). **Built** on the VPS: build
  `09d77dac1bc35b0ae58ece38968ed69b1447728e82c3c2eb5f936f6bbb7fdcee`, lockfile `1df54e35…` (unchanged). Staged and installed
  beside production at `/opt/automaton-fleet/releases/5ee36d4…`; `current` stayed 89d7c21; no unit, runtime.env, pin or
  setting changed. Kit `~/rlc134`.
- **Data rehearsal: run, PASSED (18:54:13Z)**, not carried forward. The services rehearsal refuses to start without the
  candidate's tooling tree, which only the data rehearsal creates (`/var/tmp/rollout-tooling-<commit>`). Same non-billable
  throwaway-copy procedure: 111 → 115, row counts identical, ledger verified, re-run idempotent, rollback dump restores 111
  with the same ledger head. The no-migration-change justification still holds; this is extra evidence, not a substitute.
- **Services rehearsal: PASSED (18:54:55Z).** Candidate controller, Operator API and dashboard ready on 115; 89d7c21 refuses
  schema 115 (rollback = database restore, owner-only); restored 111 with the same ledger head; production PIDs untouched.
- **Founder-upgrade rehearsal: 27/27 PASSED** (a synthetic founder on 89d7c21 upgraded, rolled back and upgraded again
  against the candidate controller; routed T1/T2/T3 calls through the fake Anthropic API; no credential in logs).
- **Revision rehearsal: 19/19 PASSED** (19:07–19:2xZ), including 4c (the delivery carries exactly the reviewed bytes) and
  4d (the buyer's request is resolved by the delivery). No evidence bundle was written (it is written only on failure).
- **Closing comparison (read-only, before 18:51Z / after):** schema 111, ledger head 1176 and verification, agents (Agent-1
  89d7c21, Agent-2 b60e262, both paused), registry state, founder cognition, unit files, units, PIDs, packages and tools
  identical; **every settings group identical** (cognition policy, tiers, routing, founder cognition, Fleet Control AI,
  review policy, AI-credit lots, balance, holds); **permanent history 329 events, same digest**. Total events 3,893 → 3,899:
  +6 `session_opened` (temporary). Only the live database and `postgres` exist; `current` 89d7c21. Before-dump kept in
  `~/rlc134/baseline-before-20261024T185115Z` (TOC 5,342 entries).

### count_tokens: NOT run — key unavailable by the owner's own directive

The approved request was not made. Production's controller runs with `FLEET_COGNITION_PROVIDER=none`: on 23 Oct
(owner directive, local-only) the key was removed from service and kept only as a root-only recovery copy
(`/etc/automaton-fleet/recovery/cognition.key.20261023T142625Z`, 0600). Using it, even for one free request, would undo
that switch, so it is reported instead. Options: the owner confirms that this recovery copy may be used for exactly one
`count_tokens` request, or runs it themselves. No inference request was made and no paid call was substituted.

### Compatibility of the 4,000-token cap with the existing runtimes (for any future deployment)

Both agents use the routed path (saved calls: Agent-1 legacy to 30 Sep, then T2/T3; Agent-2 T2 only, 7–10 Oct). Neither
has ever reached an output limit (largest outputs 2,119 and 783 tokens).
- **What changes for an old runtime:** with the candidate controller, a reply cut off at 4,000 tokens arrives as text with
  **no tool calls** (the new `outputLimit` field is ignored by old runtimes). Before, the old controller turned a cut-off
  tool call into a provider error (the turn stopped). **In both cases nothing truncated is executed.**
- **Agent-1 on 89d7c21** (`mind.ts:1011`) and **Agent-2 on b60e262** (`mind.ts:787`): a reply with no tool calls ends the
  turn as finished. The agent is **not told** its reply was cut off, so it could try the same oversized call in a later
  turn; that repetition is bounded only by its turn rate and its AI fuse (Agent-2: 3000p/60h). Only the 5ee36d4 runtime
  tells the agent and continues (at most twice).
- **Agent-2 support is therefore not assumed.** Options before any controller install:
  (a) keep the agents paused through the staged upgrade; upgrade Agent-1's runtime (Group C) before it is resumed; Agent-2
      stays paused on b60e262 while the cap is active; or
  (b) a later controller change applies the 4,000 cap only to runtimes that declare the new doctrine (founder-v10); older
      runtimes keep the tier's own limit. Not made (the candidate is frozen); proposed for approval if Agent-2 may be
      resumed unchanged.
- The legacy (non-routed) path is not capped; it keeps the policy's own `max_output_tokens` (4,000 in production).

### The reservation and the provider request use the same output limit

`routed-gateway.ts`: one value, `maxTokens = routine ? candidate.maxOutputTokens : founderStepMaxTokens(candidate)`, is
passed to `costBoundMicro(…, maxTokens, …)` (the amount authorised and reserved) and to `provider.chat({ maxTokens })`,
which the Anthropic adapter sends as `max_tokens`. Checked with a throwaway test (not committed): with production's T3
setting (16,000, adaptive thinking) the request asked for 4,000 and the reservation equalled that of a 4,000 tier
exactly; a 3,000 tier sent 3,000 and reserved 2¢ less (1,000 × 2,000 µ¢); `enabled:6000` thinking sent 7,024 (N + 1,024)
and reserved 6¢ more (rounded up to whole cents). Adaptive thinking is counted inside `max_tokens`, so the reservation
includes it. Production's tiers are T2 Sonnet adaptive 8,000 and T3 Opus adaptive 16,000; neither has an `enabled:N`
budget. The adapter still refuses locally (uncharged) any `enabled:N` budget ≥ `max_tokens`.

### Pre-existing test failures (reported separately)

The candidate's targeted tests pass **except four** in `fleet-cognition-anthropic.test.ts` (PostgreSQL integration tests at
lines 469, 514, 539, 573: two founders through the native adapter, billing exhaustion, forged thinking, the v16 charge
rule). They fail with `FLEET_INFERENCE_LOCAL_ONLY` (the test controller's default inference profile is `local_only`, from
v112) and **fail identically on 2e07e70**, before this change. They are not fixed and not hidden; the test set is not clean.

### Unchanged

Inference policy (disabled), every model assignment (T1 Haiku, T2 Sonnet, T3 Opus, Fleet Control T2), the Fleet Control
budget (unset), caching settings and credit records. No cutover, inference, runtime upgrade, budget change, credit posting
or paid evaluation. **The candidate is frozen at 5ee36d4.**

## Task routing as wired today (read-only, from code; production prices from the 24 Oct snapshot)

Prices in µ¢ per token (input / output / cache write): T1 claude-haiku-4-5 100/500/125, max output 2,000, cache off; T2
claude-sonnet-5-5 200/1,000/250, max output 8,000, cache prefix; T3 claude-opus-5-5 400/2,000/500, max output 16,000,
cache prefix.

| Task | Served by | Payer | Limits | Budget / reservation | Retry / fallback |
|---|---|---|---|---|---|
| Founder agent step (every step) | `founder_work` → **T3 Opus, deep** (owner 2026-10-20) | the agent (inference_charge) | packet ≤ 15,000 chars; request ≤ 40,000 bytes (trimmed); output = tier max 16,000; ≤ 4 steps a turn; ≤ 5 tool calls executed a step | `svc_cognition_routed_authorize`: per-founder daily budget (Agent-1 754p, Agent-2 3,000p), turns per hour (600 / 60), provider credit minus holds, one call in flight. Reservation = `costBoundMicro`: every byte as a token at the dearer of input and cache-write prices, plus tool definitions, 2,000 framing tokens and the full output allowance. **Worst case ≥ $0.53 a step on T3** (excluding tool definitions; $0.32 of it is the output allowance) | provider: 429/5xx/529 retried, ≤ 3 attempts within the deadline; unsent connection retried; **timeouts never retried**. Hourly cap: controller eligibility time, then the founder rests. **No provider or tier fallback** |
| Routine chore (`routine_task`) | T1 Haiku (routine classes) | agent | T1 output ≤ 2,000; cache off | as above | as above |
| Escalated question (`escalate_question`) | T3, one question; cache off | agent | T3 | as above | as above |
| Independent review (`independent_review`) | review helper (tier not verified here) | agent (not verified) | — | as above | as above |
| Owner conversation turn | routed founder step (T3) | treasury inside an open turn, else the agent | as a step | `svc_cognition_conversation_authorize` | as above |
| Deterministic tools: wallet, ledger, FX, hashes, time, quotas, policy, state, lookups, dedupe, filters, health, and every acting tool | **T0: no model** | — | — | — | — |
| Fleet Control spend review | T2 Sonnet | treasury (`spend_review_charge`) | output ≤ 1,500 | `svc_fleet_control_ai_reserve` vs the daily ceiling (**unset: none run**); claim pre-filter 3p (an estimate, not a cap) | ≤ 5 attempts, 60 s base backoff |
| Fleet Control knowledge review | T2 | treasury (`knowledge_review_charge`) | output ≤ 800 | same ceiling | bounded attempts, then stalled |
| Evidence relevance | `evidence_relevance` (T2–T3) | Fleet Control (payer not re-verified here) | output ≤ 4,000 | same ceiling + hourly relevance cap | failed call recorded; bounded |
| **Message check (v115)** | T2 | treasury (`message_check_charge`) | output ≤ 300; input clipped (message 4,000, 6 × 600 earlier, 10 × 300 criteria) | same ceiling. **Worst case 4,861,400 µ¢ ≈ 3.63p; typical "thanks" 565,600 µ¢ ≈ 0.42p** (by code) | budget refusal: 15-min deferral, not an attempt; 3 attempts (5 / 30 min), then stalled |
| Local model | `provider: local` only (profile local) | none (zero price) | compact tool list (local only) | founder budget/turn caps still apply | **no cloud fallback** |
| Scenario suite (evaluation) | routed as founders, side-installed release | engineering (imported once) | per-scenario caps | credit hold placed before the run | as founder steps |

**Efficiency measures:**
- **Implemented and active:**
  - T0 deterministic classification (tools never buy inference);
  - event-driven wakes, hibernation and idle backoff (free signals);
  - packet and request bounds; images bounded by pixels;
  - one call in flight; duplicate-failure refusal;
  - hourly-cap eligibility time (v112) with the founder's rest;
  - owed-recheck backoff (v114);
  - one message check per message (v115);
  - true-maximum reservations.
- **Implemented and configured:** prompt caching `prefix` on T2/T3, applied only when a tool loop continues or the same
  model was used within the cache lifetime. It is off for T1 and one-off escalations, and `prefix+tail` is not configured.
- **Implemented but disabled or not configured:**
  - Fleet Control (daily budget unset: spend, knowledge, relevance and message checks do not run);
  - the cognition policy (contained since 23 Oct);
  - the local provider and compact tools (local profile only).
- **Configured choice that drives cost:** every founder step on T3 Opus with deep reasoning (owner 2026-10-20). Routine T1
  exists, but only when the founder explicitly delegates with `routine_task`.
- **Gaps (proposed only, nothing built):**
  - founder steps reserve the tier's full output allowance (16,000 on T3), so reservations are large (plan B's
    starvation) and a per-task output cap is missing;
  - Fleet Control checks use T2 where a T1 check may suffice for messages;
  - no batch pricing for non-urgent reviews;
  - `prefix+tail` caching is unused;
  - routine work inside T3 steps is not routed down automatically.

## Item 5: confirm the runtime key belongs to the funded organisation (owner-side; nothing exposed)

1. **VPS (owner, sudo).** Print only the key's last four characters, which the Console shows anyway:
   `sudo sh -c 'f=$(ls /etc/automaton-fleet/recovery/ | head -1); tr -d "\n" < "/etc/automaton-fleet/recovery/$f" | tail -c 4; echo'`
   (`sudo ls -l` the folder first if it holds more than one file).
2. **Console.** Switch to the organisation whose **Billing** page shows the Max-included promotional credit (the funded
   organisation). Open its **API Keys** page and find the key whose displayed hint ends in those four characters.
   - **Found there:** the runtime key belongs to the funded organisation. Note the key's workspace and its last-used date;
     23 Oct 2026 is expected (the last paid runs ended 13:44Z, the key was contained at 14:26Z).
   - **Not found there:** the key belongs elsewhere and cannot spend the grant. The fix is a new key created in the funded
     organisation and installed by the owner. Fleet makes no provider change.

The check sends no request to the API, and no response header is relied on.

## Credit reconciliation: proposal (for approval; nothing posted, no wallet charged)

No recommendation is made on charging agents. An internal agent charge is a transfer inside the Fleet, not a provider
expense, and it is shown separately below for the owner to decide.

**Inputs.** Each comes from a named source and is never estimated. Usage outside Fleet is never attributed to an agent.

| # | Figure | Source |
|---|---|---|
| G | promotional grant: amount (USD), date granted, **expiry**, grant identifier | Console → Billing of the organisation confirmed by the key check |
| Rp | promotional remaining balance | Console → Billing (same page) |
| Rb | purchased remaining balance | Console → Billing (purchased or prepaid credit, as the Console separates it) |
| Lb | Fleet's recorded purchased remainder: lot 05f4cb13, **1,676,179,930 µ¢ ($16.76)** | Fleet ledger (v70 lots); read at deployment Group A |
| Uf | Fleet's own provider consumption since 2026-10-23 14:26Z | Fleet cognition log; **0 expected** (cognition contained, agents paused) |
| Uc | the provider's usage/cost for the same period, by date | Console → Usage / Cost |

**Reconciliation**, computed by code (Decimal, in µ¢) and shown before anything is posted:
- **Promotional consumption** = G − Rp. Fleet's share is only Fleet's own calls (Uf, by request ID). Anything else is
  consumption outside Fleet, recorded as an observation.
- **Purchased consumption** = Lb − Rb. If Uf = 0 and this is not 0, the difference is purchased credit used outside Fleet
  (or by a draw order the Console shows). It is recorded as an observation with both figures. It is never deducted from
  an agent and never posted to the GBP books without the owner's word.
- **No overwrite and no double count:** lot 05f4cb13 stays as recorded, and its remainder changes only by a recorded,
  explained event. The grant is entered once, as its own lot and never added to the purchased lot.
- **Draw order:** taken from the Console (which balance falls when Fleet calls), confirmed on the first Fleet calls after
  enabling inference. It is not assumed.

**Proposed records** (a migration after v114; none written yet):
- lot source **`promotional`**: G, Rp, expiry, grant identifier, acquisition cost 0;
- provider-credit event kind **`grant`**, never `purchase`;
- **consumption events tagged by source**, so promotional and purchased consumption are reported separately;
- an `expiry` event at the grant's expiry.

A promotional draw creates no owner payable (nobody paid for it) and no treasury asset.

**Provider expense versus internal charge**, kept apart in every report:
- *Provider expense*, actual: purchased consumption at its acquisition cost (owner-funded, owed to the owner as today,
  v69–v72). Promotional consumption has **no cash cost**.
- *Internal agent charge*, **proposed only and shown separately**: what agents would be charged for promotional-funded
  calls. Options for the owner:
  - none;
  - the provider list price, with the matching amount shown as a separate internal line.

  The report shows the figure under each option. **No wallet charge or entry is authorised by this proposal.**

## The saved defective PDFs against the merged inspector (24 Oct)

All 13 PDFs in the desktop evidence were run with the merged inspector (sha256 84749a94c892f173…), using the pinned agent
tools. (A first attempt ran Python with `-I`, which hid the pinned PDF libraries, so no PDF check ran. It was discarded and
is not counted.)

| Evidence | Defect a viewer shows | Merged inspector |
|---|---|---|
| run 2 `checklist.pdf` | plain text named .pdf | **fail** `extension_matches` |
| run 3 `checklist.pdf` (delivered) | 8 of 10 points past the right edge | **fail** `text_off_page` (346 characters) |
| run 3 `checklist_revised_final.pdf` (delivered) | title clipped | **fail** `text_off_page` (13 characters) |
| run 3 `checklist_revised.pdf` | plain text named .pdf | **fail** `extension_matches` |
| run 4 `gas-safety-checklist.pdf` (the revision) | rows drawn over the next column | **fail** `text_overlap` |
| run 5, both delivered files and both workspace copies | damaged stream; viewers show the title only | **fail** `pdf_content` (×4) |
| run 6, both delivered (byte-identical, 2e91c888…), the workspace copy, the first snapshot | legible, but numbered twice; the requested point-7 date line **missing** | pass (a sound file) |

Run 6 is the limit of file inspection: a readable PDF that does not contain the buyer's change. The desktop's own verdict
(`run6-…/VERDICT.md`) is **failed**. The answer there is v113 plus the `required_content` review check, which needs the
requested change visible on the page; it is not the inspector. Doubled numbering ("1. 1.") is not detected by any check.
It is a content-quality limit.

## Tests (final candidate; non-billable, no inference call, loopback only)

`npx tsc --noEmit` is clean.

**Continuity test 1j: fixed narrowly.** The test rig answered a script that returns a never-settling promise (1j's
simulated kill) at once with `toolCalls: undefined`. The abandoned turn then failed later as an unhandled rejection. The
rig now awaits a script's promise, so the "killed" call never returns, as the test intends. Nothing is suppressed, and
runtime code is unchanged. `fleet-founder-work-continuity` gives **31/31, runner exit 0, no unhandled errors**.

**Affected checks, one sequential run (14 files):**
- 13 files and 165 tests passed: the v114 regression, obligations (unit and PostgreSQL), the founder runtime and tools,
  the privilege audits (phase4, including v114's registered writer), the migration paths v8/v24 → **v114**, v112, and
  the review refusal case.
- **1 failure:** `fleet-cognition-hardening` L2. A fake provider hangs 600 ms against a 2.5 s controller deadline, and
  that deadline was exceeded once under VM load. Runner exit 1; no unhandled errors.
- **Rerun of that file alone, twice: 16/16, exit 0 both times.** It also passed 16/16 in both earlier runs today.
  Nothing changed today touches the provider or deadline path, so it is recorded as a **timing-sensitive test, not a
  regression**. It needs a quiet machine for release evidence.

**Release evidence for the v115 candidate: one clean run** (quiet machine, sequential, deadlines unchanged), on **084585d**
(the frozen head adds only this record): 22 focused files, covering obligations and v115, the founder runtime and tools,
privileges, migration paths v8/v24 → **115**, v112, the review refusal, the message checker, Fleet Control (spend and
knowledge reviews, reservation), AI-credit reimbursement and capital backing, release tooling.
- **21/22 files, 232/233 tests passed; runner exit 1; no unhandled errors.**
- **The one failure: `fleet-cognition-hardening` L2**, a timing test, which also failed once at c6d4699 (before v115) and
  passed in the other runs and alone.
- **Mechanism:** the fixture's fake provider hangs **600 ms** against a per-attempt provider timeout of **800 ms**. A
  timed-out attempt is never retried, correctly, because the provider may have processed and billed it. So scheduling
  delay over 200 ms late in a long run fails the test. Production code and deadlines are not involved.
- **Not changed:** widening that fixture's margin (for example a 450 ms hang, still slower than the client's 300 ms
  timeout the test is about) would stop the flake without touching any production deadline. It needs the owner's word,
  because it changes a test's timing.

**Release evidence: the clean run (quiet machine, load ≈ 0.4, no other test process), on 8475471 (code identical to
c6d4699):** the same 14 files, sequential: **14/14 files, 166/166 tests, runner exit 0, no unhandled errors.** That
includes `fleet-cognition-hardening` L2 with its deadline unchanged.

**Earlier today, before v114:** the combined merge ran 26 files and 296 tests, all passing. Its runner exit 1 came from
the 1j unhandled rejection, now fixed.

**Missing PDF dependencies cannot yield a pass.** When a library is not importable, the inspector reports a
`tool_unavailable` warn, and the file can still say `ok`. FleetController does not trust that.
`fleet_econ_review_record` (v76; v109 is the latest restatement, and v110–v113 do not touch it) sets `automated_ok` false
when any check is `tool_unavailable`, and refuses a `pass` verdict with `FLEET_REVIEW_AUTOMATED_FAILED`. Delivery and
publication need a passing review of exactly those bytes. So a check that could not run leaves the work **blocked**,
never approved. The new case records a pass on an `ok: true` report carrying only a `tool_unavailable` warn: refused.
The scenario grader's "completed" is not a review. It never read the documents (runs 3–6), and its verdict is not
evidence of fulfilment.

## Deployment proposal: four approval groups

| Group | Exactly what | Live effect | Needs first | Spend |
|---|---|---|---|---|
| **A: candidate, side-build, non-billable rehearsals** | Push the frozen candidate (the branch head named in the Group A request). On the VPS: `fleet-build-runtime.sh` → pins (from its output). `fleet-rollout.sh rehearse <pins> 111 115`: a fresh read-only dump restored into a **throwaway** database; it never writes to the live one. The free rehearsals (services, founder upgrade, revision) in throwaway registries with the **fake** provider. A read-only snapshot of policy, tiers, routing, budgets, lots and holds. | none | your approval of A only | no additional model/API spend (no provider key is used or present in any rehearsal); VPS build time and disk only |
| **B: production install/configuration, agents paused** | **B1:** `fleet-release.sh <pins> 111 <to> <current UI>`, with automatic database restore **off** (the default since 4c9c1a3); verify identity, schema and the snapshot. Cognition stays contained (provider none). **B2:** key from recovery to its credential, `FLEET_INFERENCE_PROFILE=cloud_allowed`, `FLEET_COGNITION_PROVIDER=anthropic`, profile set if needed, policy re-enabled with the snapshot's values, controller restart. | B1: controller outage ≈ 45 s. B2: one controller restart. | B1: your B approval (and Group A's results). B2: **the key check** (funded organisation) | no additional model/API spend (agents paused, Fleet Control ceiling unchanged); a brief outage |
| **C: named runtime upgrades, agents paused** | **Agent-1 (founder-1, 01M3F50SH7PNX2E3GST13J52AS) only**: `fleet-founders.sh` upgrade from 89d7c21 to the installed release; record the upgrade ID. **Agent-2 (01M4C4NXT786Q4E9725N5A15KV) stays on b60e262** unless you explicitly approve its upgrade. | Agent-1's process restarts, still paused | B1 | no additional model/API spend |
| **D: paid evaluation (separate approval)** | S1 from the side-installed release in a throwaway registry, on terms frozen by `fleet-scenario-terms.sh`, hold placed, import once. | none on production agents | B2; **the credit figures** (the hold is placed against the recorded balance) | S1 cap 360p; hold **$4.01 provisional**: computed from plan C's terms of 23 Oct, recomputed from current terms before approval |

**What needs the key, credit figures or charging decision:**
- **Key organisation:** only B2 (installing the key makes provider calls possible) and anything after it.
- **Credit figures:** only D's frozen terms and the read-only reconciliation report.
- **Internal agent charge:** none of A–D (D charges a throwaway scenario registry and imports as engineering expense).
  It is needed only before agents resume real work on promotional credit.

A, the key check and the reconciliation can therefore proceed independently. The key check and reconciliation stay
read-only. No internal agent charge is approved.

**Kept throughout:** no automatic production database restore; agents paused; resuming them is a separate word from the
owner.

## Rollback

- **Group A:** nothing live changed (the rehearsal database is throwaway); delete nothing.
- **Group B, the install fails after the migration:** the rollout stops the controller-side units and **restores nothing** (the
  database, the pre-migration dump, runtime.env and logs are kept). The owner chooses fix forward (preferred) or
  `FLEET_ROLLOUT_AUTO_RESTORE=1 scripts/fleet-rollout.sh revert <pins> 111 <to> <reason>`. That is an explicit restore of
  the verified pre-migration dump and loses everything recorded after it, so it is acceptable only before agents or
  cognition resume. 89d7c21 never runs on a newer schema.
- **Group B, the Anthropic part:** the 23 October containment again:
  - policy disabled;
  - `FLEET_COGNITION_PROVIDER=none`;
  - key back to the recovery folder;
  - restart the controller.

  Optionally `inference-profile-set local_only`, which disables cloud tiers and policy. No database restore.
- **Group C, Agent-1's runtime:** `scripts/fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`.
- Once real money or provider data exists after Group B: freeze and fix forward (README §3).

## Proposed bounded evaluation (Group D; paid; separate approval; figures PROVISIONAL)

Scenario S1 only (paid order, then a correction, on the approved Opus routing), cap **360p**, which bounds the run.
- **Provisional:** derived by code from plan C's terms of 23 Oct (1150p ↔ 1,281,805,763 µ¢), hold **401,260,935 µ¢ ($4.01)**. It is recomputed from current terms before any approval.
- Plan C's actual S1: 278.50p.
- Optional S1 + S2 (two hard kills): cap **610p**, hold **679,914,362 µ¢ ($6.80)**; plan C actual 392.11p.

These figures are re-frozen at approval by `fleet-scenario-terms.sh`, with today's FX and lot. The run is approved only
on the frozen figures. The ledger's recorded credit is 1,676,179,930 µ¢ ($16.76).

The S1 grader does not open the PDF (desktop runs 3–5). With the desktop's inspector checks merged, broken files fail
review. The delivered files are still checked by hand before any pass is claimed.

## Remaining before approval

1. **For A:** your approval of Group A only. Nothing else blocks it.
2. **For B1:** your B approval, after Group A's rehearsals pass (the customer-message design is implemented as v115).
3. **For B2:** the key check (four characters on the VPS, then the Console). Read-only.
4. **For D:** the Console figures for the reconciliation (G, Rp, Rb, Uc) and recomputed terms. Read-only; nothing is
   posted.
5. **Not needed for A–D:** an internal agent charge decision (none is approved), the later proposal archive, the desktop's
   cluster inventory.
6. **Known and recorded:** the 8 failures the desktop recorded in `fleet-cognition-anthropic`, `r24-experiments`,
   `research` and `storefront-gateway-pg` (present before this work; not in the release evidence set).
