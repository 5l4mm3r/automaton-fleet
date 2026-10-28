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

## INSTALLED: 81e1ae5 in production (Group B), 26 Oct 16:04:42–16:06:42Z — and the S1+S2 credit reconciliation CLOSED

Approved by the owner: commit `81e1ae5e6a2928797ec9f69e59317c40e7e1c760`, expected build `23c34147046d33a36cbdb42d4afed56ebc4e6b7314b09b3a46cf67f00fff49eb`.

**Before running:** the staged `~/rlc136/install.sh` and the reviewed `install-81e1ae5.sh` matched in full (sha256
`4500e9b5cde132e50d2989c3d41dd1c7a4bc1e3cc403bf39dbdb7290ed0b57b4`). Pins: commit and build as approved.
`FLEET_ROLLOUT_AUTO_RESTORE` unset. All gates passed before any change.

**Install:**
- **Pre-install backup:** `~/rlc136/baseline-pre-install-81e1ae5-20261026T160444Z` (5,457 dump entries; kept; never restored).
- **Release:** `fleet-release.sh` 118 → 119. Outage 16:05:46–16:06:32Z (**46 s**). Cutover reconciliation OK (3,422 events
  preserved). Rollout deployed 16:06:39Z; release deployed 16:06:40Z; root UI 0.26.2 unchanged.

**Verified after the install:**
- **Identity:** `current` → `releases/81e1ae5…`; the build identity of the installed tree is `23c34147…` / lockfile
  `1df54e35…`; readyz ready, schema v119, runtime release `@81e1ae5…`.
- **Ledger:** head 1176 `e214852e…` unchanged; 1,117 journals; verify **true**.
- **Credit:** total **11,523,033,480 µ¢ ($115.2303348)**: purchased lot 1,722,000,000 ($17.22), promotional lot 9,801,033,480
  ($98.0103348). Held **0**. Owner payable **1,081p** (unchanged).
- **Agents:**
  - Agent-1: runtime 5ee36d4, paused, **PID 2004178** (unchanged), 754p/day, 600 turns/h (unchanged);
  - Agent-2: b60e262, paused, **PID 866408** (unchanged).
  - Both heartbeating again at +26 s.
- **Still off or closed:** inference (policy f, provider none); Fleet Control ceiling unset; sales closed; no credit hold; **no
  canary unit installed**; authorities closed; safety flags false.
- **v119 checks (script):**
  - held includes open reservations;
  - no path subtracts them twice;
  - the daily limit reports usage;
  - held 0;
  - the release contains the guard; unit files unchanged.
- **Settings pre-install → post-install:** **0 differences.**
- **Events since the start:**
  - `production_deployed` 1, `runtime_approved` 1, role grants;
  - 2 `api_auth_failed` on `/v1/heartbeat`: the same pair seen at every controller restart.
- **Not done:** no credit entry, hold, timer, funding, paid call, agent resume or restore.

**Rollback:** 81e1ae5's schema 119 is refused by bc19e05, so going back is a restore of the pre-install backup: **owner
decision only; none authorised.** Fix forward is preferred.

### S1+S2 credit reconciliation: CLOSED (owner's Console reading, 26 Oct)
| | Console (Kai) | Fleet records | Difference |
|---|---|---|---|
| Promotional | $98.01 | $98.0103348 | $0.0003348, within cent display |
| Purchased | $17.22 | $17.22 | 0 |

The run cost $1.9896652. The Console's promotional balance fell by $1.99 and its purchased balance did not move, so
**Anthropic billed this run against the promotional balance, matching Fleet's allocation.** No entry is needed.

## Group A on 81e1ae5 (26 Oct, 15:56–16:01Z): PASSED; production unchanged — and the Group B package (prepared, not run)

Approved by the owner, Group A for code commit `81e1ae5e6a2928797ec9f69e59317c40e7e1c760`.
- **Docs head** `212e76c3435eeca3b2bfa827d237fa45a78dd7bd`. `git diff --name-only 81e1ae5 212e76c` lists only
  `docs/evaluations/launch-candidate/candidate-integration-v2.6.md`, so the changes after the code commit are documentation only.
- **Approval-record wording (owner):** **$15 is an authorisation ceiling based on reserved estimates, not an unconditional
  provider-billing guarantee.** An underestimated call (provider cost above its estimate) can exceed it; that is recorded and
  becomes a cost exception that stops further agent calls.

| Step | Result |
|---|---|
| Push | `fleet/canary-prep`, new branch, no force; remote head `212e76c`; 12 commits beyond the pushed `fleet/funding-v116` |
| Build (VPS) | Pass 1 read the identity; pins written from its output (`~/rlc136/pins.txt`); pass 2 verified: **build `23c34147046d33a36cbdb42d4afed56ebc4e6b7314b09b3a46cf67f00fff49eb`**, lockfile `1df54e35…` (unchanged) |
| Side-install | `/opt/automaton-fleet/releases/81e1ae5…`, identity re-verified; `current` stayed bc19e05 |
| Data rehearsal `fleet-rollout.sh rehearse 118 → 119` | **PASSED 15:59:08Z.** Row counts identical; only 119 applies; privilege audit; ledger head unchanged; reconciliation OK (1,117 journals; history preserved); verify true; re-run applies nothing; rollback restores 118 with the same head |
| Services rehearsal `fleet-upgrade-rehearsal.sh 118 → 119` | **PASSED 15:59:51Z.** Candidate controller, Operator API and dashboard ready on 119; bc19e05 refuses 119 (rollback = database restore); restore to 118 with the same head; bc19e05 ready; production PIDs untouched |
| Disposable copy (`copy-check.sh`, then dropped) | Schema 119. **Shared in-flight figure:** `fleet_provider_credit_held` includes model-call reservations; no authorisation or the engineering hold subtracts them separately (0). A 25-cent in-flight reservation raised held by exactly 25,000,000 µ¢ (once). With 5¢ free, Fleet Control was **refused 7¢** (`FLEET_CONTROL_AI_BUDGET_UNFUNDED`) and **got exactly 5¢**; free then 0. **Release guard dry run:** `fleet-canary.sh check --dry-run` (deadline passed) printed the safe stop and **kept the ceiling hold** ("2 reservation(s) still open"). Copy state (journals, events, paused flags, sales, open holds, Fleet Control ceiling, offer status) identical before/after; **0 files written** |
| Production before/after (15:56:11Z / after) | Identical: schema 118; ledger head 1176 `e214852e…` (verify true); agents (Agent-1 5ee36d4 PID 2004178, Agent-2 b60e262 PID 866408, both paused); state; founder cognition; units; unit files; PIDs; packages; tools; **all settings groups**; events 3,420 → 3,420 (no new event); permanent history 339, same digest. `current` bc19e05; inference off (policy f, provider none); Fleet Control unset; sales closed; no open credit hold; only the `automaton_fleet` and `postgres` databases |

**Carried forward:** the founder-upgrade (27/27) and revision (19/19) rehearsals of 24 Oct. No founder-runtime, cognition
gateway or package file changed since 5ee36d4; Agent-1 stays on 5ee36d4. No paid run.

### Group B: installation package (prepared; NOT run; needs your approval)
- **Script:** `install-81e1ae5.sh` beside this record, sha256 `4500e9b5cde132e50d2989c3d41dd1c7a4bc1e3cc403bf39dbdb7290ed0b57b4`.
  Staged identically as `~/rlc136/install.sh`.
- **Run:** `bash ~/rlc136/install.sh`.
- **Pins:** commit `81e1ae5e6a2928797ec9f69e59317c40e7e1c760`, build `23c34147046d33a36cbdb42d4afed56ebc4e6b7314b09b3a46cf67f00fff49eb`,
  lockfile `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1`. UI 0.26.2 unchanged (reused).
- **Gates (all must hold before any change):**
  - the pins;
  - both rehearsals passed, of 81e1ae5, < 24 h old;
  - UI checksum;
  - the side-installed release present;
  - both agents paused on 5ee36d4 / b60e262;
  - inference off;
  - permissions closed;
  - the four safety flags false;
  - live schema 118 on bc19e05;
  - **no open provider-credit hold**;
  - **no canary unit installed**;
  - the founder unit template unchanged;
  - `FLEET_ROLLOUT_AUTO_RESTORE` unset.
- **Pre-install backup:** a full dump, kept and never restored by the script.
- **Release:** `fleet-release.sh` 118 → 119, about 45 s controller outage. **No founder restart, no runtime change.**
- **Verification:**
  - readyz 200;
  - both agents paused, same runtimes and **same PIDs**;
  - inference off; tiers unchanged;
  - ledger head unchanged (v119 posts nothing); credit balance and owner payable unchanged;
  - draw order promotional first; T2 cache read 10;
  - control_reserved 0, and the promotional lots exactly the recorded grant;
  - credit-source lookup in the 3 paths;
  - **v119:** held includes open reservations, no path subtracts them twice, `fleet_cognition_state` reports usage, and held
    is 0 after install;
  - the release contains the guard script and SQL;
  - **no canary unit installed; the installed unit files are unchanged**;
  - safety flags false; permissions closed; ledger verifies.
- **Not done by it:** no credit entry, credit hold, timer, Fleet Control budget, provider activation, agent resume or restore.
- **Rollback:** bc19e05 refuses schema 119, so going back is a restore of the pre-install backup. That is **your decision
  only; none is authorised.** Fix forward is preferred.

## FINAL canary candidate 81e1ae5 (26 Oct ~15:55Z; local; for Group A approval; supersedes a0cb8c8 below where they differ)

Commit `81e1ae5e6a2928797ec9f69e59317c40e7e1c760`, branch `fleet/canary-prep`, local, not pushed, on a0cb8c8 / 0fa9534 /
docs. Schema 118 → 119 (no posting). No founder runtime or UI change. The S1+S2 evidence (`evidence-scen-bc19e05-s1s2/`) is
unchanged.

### 1. The $15 ceiling is now hard
- **The gap (a0cb8c8):** Fleet Control's reservation subtracted `fleet_provider_credit_held`, which did not include the agents'
  open model-call reservations, so it could take credit an agent's call in flight held.
- **v119 (final):** `fleet_provider_credit_held` = engineering and ceiling holds + open Fleet Control maxima + promotional credit
  expiring within 60 min + **every open model-call reservation** (live or expired, at its USD estimate).
  - Agent authorisations (agent- and treasury-paid) and the engineering hold no longer subtract those reservations a second
    time.
  - Every consumer reads this one figure under the same `fleet_provider_credits:<provider>` advisory lock.
- **`fleet-v119-credit-one-figure-pg` 4/4; it fails 4/4 when the fix is removed:**
  - a reservation is counted once and leaves the figure when recorded;
  - with $0.30 free and an agent holding $0.25, Fleet Control is refused $0.07, gets exactly $0.05, and another agent is then
    refused;
  - 3 agent calls of $0.20 and 2 Fleet Control calls of $0.07 run at once against $0.50 never take more than $0.50, each taken
    amount counted once;
  - the engineering hold can take exactly what is free.
- **Remaining way past it:** a provider cost above a call's own estimate (an overrun). That is recorded, becomes a cost
  exception, and stops further agent calls.

### 2. The £10 cash threshold, stated honestly
The hourly guard compares Agent-1's posted charges since the start with £10.00 and stops at the first check above it, so it
can be overshot between checks.

**Maximum exposure:**
- a stop up to an hour late, plus the rolling daily limit of 754p, would allow up to **£17.54**;
- **but** posted charges can never exceed what the calls cost, and Fleet's total cost is capped by the **hard** $15 ceiling:
  1,500 US cents × 0.748039 = 1,122.0585p, so at most **1,123p (£11.23)**.

So Agent-1's cash exposure over the canary is **at most £11.23**. That applies only if every call were purchased credit; with
promotional credit drawn first ($98.01 left against a $15 ceiling), the expected cash charge is about £0.

### 3. The duplicate guard detects repeated execution
`scripts/fleet-canary-measures.sql` (read-only), used by `fleet-canary.sh`:
- **Repeated delivery:** an order with more than one sent delivery that declares **no** resend reason. Not counted:
  - revisions and deliberate resends, which declare a reason;
  - retries (one delivery row, `attempts` > 1);
  - the same bytes resent for a stated reason.
- **Repeated message:** an agent message identical to one it sent on the same order **within the previous 30 minutes with no
  buyer message between**. The same words after the buyer wrote again, or later than that, are not counted.
- **`fleet-canary-measures-pg` 4/4 (on a real registry):**
  - empty canary clean;
  - a retried delivery, a declared revision and a deliberate same-bytes resend → 0;
  - two undeclared sent deliveries → 1;
  - repeated words after a buyer message or 110 min apart → 0; replayed a minute later → 1.
- **`fleet-canary-guard` 10/10** (stub psql/CLI): dry run mutates nothing; each trigger stops once; the end keeps the hold while
  reservations are open.
- **Read-only dry run on production** (Agent-1's real history since 18 Oct): repeated deliveries 0, repeated messages 0;
  nothing written.

### 4. Test totals (exact, all retained)
| Run | Result |
|---|---|
| First full run of a0cb8c8 (33 files) | **31/33 files; 291/299 tests.** Failures: `fleet-cognition-anthropic` 4 (known) and **`fleet-v111-cognition-settlement-pg` 4, caused by v119** (open reservations count toward the daily limit, which refused its first case before the cash rule it tests; the stranded hold failed 3 later cases) |
| `fleet-v111-cognition-settlement-pg` after setting its daily limit out of the way | **10/10** (separate rerun) |
| **Final run of 81e1ae5 (35 files)** | **34/35 files; 303/307 tests.** Only failures: **`fleet-cognition-anthropic` 4 known `FLEET_INFERENCE_LOCAL_ONLY`** (13/17), unchanged since before this work |

`tsc --noEmit` is clean.

### 5. Group A for 81e1ae5 (for approval; nothing done)
1. **Push:** `git push fleet-origin fleet/canary-prep` (new branch, no force), carrying 0fa9534, a0cb8c8, 81e1ae5 and the docs
   commits on top of the pushed `fleet/funding-v116`.
2. **VPS build of 81e1ae5:** pins from the build output.
3. **Side-install** beside production (`current` stays bc19e05).
4. **Data rehearsal 118 → 119 and services rehearsal** on disposable copies: row counts, privilege audit, ledger head unchanged,
   re-run no-op, rollback restore; candidate services ready; bc19e05 refuses 119.
5. **On the copy:**
   - `fleet_provider_credit_held` includes open reservations;
   - a guard dry run with the release's script and SQL file writes nothing.
6. **Production before/after identity.**

Founder-upgrade and revision rehearsals are carried forward (no founder-runtime file changed).

**Then (separate approvals):**
- **Group B:** bc19e05 → 81e1ae5, schema 118 → 119, no agent restart, inference off.
- **Activation:** the steps listed in section 4 of the consolidated package.

## Canary candidate a0cb8c8: v119, canary guard, tracker layout (26 Oct ~15:45Z; local; nothing installed or activated)

Branch `fleet/canary-prep`, local, not pushed. It contains:
- `0fa9534`: harness document tools;
- `a0cb8c8a999205889683ea49ef1e8702e707d5e7`: v119, `scripts/fleet-canary.sh`, the canary systemd units (not installed) and tests.

Base: production bc19e05 / schema 118. Schema 118 → **119** (one function restated; it posts nothing). No founder runtime or UI
change.

### v119: the daily limit counts usage whichever credit pays
`fleet_cognition_state` now computes the rolling-24-hour spend as:
- the intended charge of every agent-paid call, i.e. its cost at the call's controlled rate whichever credit paid;
- **plus every reservation of the agent still open** (at its reserved estimate).

The state also reports `usageTodayMicrocents`, `reservedOpenMicrocents` and `chargedTodayMicrocents` (what was actually
charged), separately. Authorisation is unchanged: one at a time per agent (agent row lock, one live call), refused when the
estimate does not fit. Nothing is charged, refunded, rewritten or owed; promotional use stays charged to no one.

### Tests (exact)
- `tsc --noEmit` clean.
- 33 files run together (`--maxWorkers 4 --minWorkers 1`): **31 passed; 291 of 299 tests passed**, then
  `fleet-v111-cognition-settlement-pg` passed 10/10 on its own once its daily limit was moved out of the way.
- **`fleet-cognition-anthropic` still has its 4 known `FLEET_INFERENCE_LOCAL_ONLY` failures (13/17).** The set is not entirely
  clean.

New or changed:

| File | Result | What it proves |
|---|---|---|
| `fleet-v119-daily-limit-pg` (new) | 5/5 | Promotional calls are stopped at 100p with £0 charged and owed. An expired, unrecorded reservation counts until recorded, then once. Concurrent authorisations: one passes, the other `BUSY`. A replay is refused and nothing is recounted. Mixed and purchased calls count their full usage (the charge stays the purchased part). |
| `fleet-v111-cognition-settlement-pg` | 10/10 | Its daily limit is now set out of the way. **Reason:** v119 refused its first case at the daily limit before the cash rule it tests, and the stranded hold then failed 3 later cases. The cash rule is unchanged and still proved. |
| `fleet-canary-guard` (new; stub psql/CLI) | 10/10 | `--dry-run` mutates nothing (no action, no marker, no log). Each of 5 triggers stops once (pause, offer hold, sales closed, Fleet Control budget off) and later checks do nothing. An unknown-cost reservation is a warning, not a stop. The end keeps the credit hold while any reservation is open and releases it only when none is. Past `ENDS_AT`, the hourly check ends the canary itself. |
| `fleet-scenario-document-tools` (new) | 3/3 | the harness wiring, on the saved PDFs |

**Dry run of the guard against production, read-only, 15:23Z:** measures read correctly; the forced-ceiling and the
past-deadline runs printed exactly the safe-stop and release actions; production unchanged.

### Exact limits for the canary (7 days)
| Limit | Value | Kind |
|---|---|---|
| Agent-1 daily usage (rolling 24 h) | **754p** at charge rates (≈ $10.08 at FX 0.748039), **including open reservations, whichever credit pays** | automatic (v119) |
| Turns per hour | **120** | automatic |
| Provider credit for all Fleet calls, 7 days | **$15.00** (= 1,500,000,000 µ¢) | automatic: ceiling hold, plus the hourly guard |
| Agent-1 cash charges, 7 days | **£10.00** (1,000p) | automatic: the hourly guard stops |
| Fleet Control, rolling 24 h | **30p** (at most 210p over 7 days, inside the $15) | automatic |

**How the $15 ceiling counts calls in flight:**
- **The hold:** `canary-agent1-ceiling`, amount = recorded balance − 1,500,000,000 µ¢ at activation.
- **An agent call** is authorised only if balance − held (engineering and ceiling holds, open Fleet Control maxima, and
  promotional credit expiring within 60 min) − **every open cognition reservation** (live or expired, at its USD estimate)
  ≥ its estimate.
- **A Fleet Control call** reserves only if balance − held ≥ its maximum. It does **not** subtract open agent reservations,
  so a Fleet Control call that starts while an agent call is in flight can overshoot by at most that Fleet Control call's
  maximum (message check ≤ 7.1¢; worst case relevance T3 ≤ 21¢). Disclosed; not changed.
- **Actual costs** replace estimates at settlement. Only an overrun (a provider cost above the estimate) can exceed it; that
  is recorded and becomes a cost exception that stops the agent.

### Automatic expiry and reservation cleanup
- **The end** fires at `ENDS_AT` (start + 7 days) via `automaton-fleet-canary-end.timer` (`Persistent=true`). The hourly check
  also ends the canary once `ENDS_AT` has passed: two independent triggers.
- **The end:**
  - runs the safe stop (pause Agent-1, hold the offer, close sales, clear the Fleet Control budget);
  - releases the ceiling hold **only if** no cognition reservation of Agent-1 and no Fleet Control reservation is open or of
    unknown cost.
  - Otherwise the hold stays and the log says so. You then resolve: `economy-cognition-resolve` /
    `economy-fleet-control-ai-reconcile` from provider evidence, then `economy-engineering-credit-release`.
- **Reservations clean themselves up where they can:**
  - a cognition reservation expires after 5 minutes but stays held until recorded or resolved (v111);
  - a Fleet Control reservation is settled by the minutely sweep after 15 minutes from its recorded consumption, otherwise
    marked unknown with its hold kept (v117).
  - Nothing releases credit for an unresolved call.
- **Not automatic:** setting provider `none` and moving the key back to recovery (root and a restart). That is your step if
  you want inference fully off after the end.

### What runs persistently without this Claude session
| Already in production | |
|---|---|
| Controller lifecycle pass (every minute) | settlements, the Fleet Control sweep, reservation expiry, promotional-credit expiry |
| Hourly operations watch | health findings, overdue paid orders, low AI credit → notifications |
| Fleet Command + owner email notifications | P0–P3 events (offer held, budget changes, cost exceptions, exhaustion alerts) |
| `automaton-fleet-heartbeat.timer` (5 min) | external monitor ping; failed checks named |
| Backup (daily) and backup drill (weekly) timers | |

| New with the canary (installed by you at activation) | |
|---|---|
| `automaton-fleet-canary-check.timer` (hourly) | the measures above and the automatic safe stop |
| `automaton-fleet-canary-end.timer` (once, at `ENDS_AT`) | the end and conditional release |

| Needs a session (me) or you | |
|---|---|
| Inspecting each real delivered file; Console reconciliation (Fleet's split against the Console); judging complaints; the daily report | |

### Tracker: print-layout correction (separate candidate file; the live offer is NOT changed)
- **Candidate:** `canary-tracker-candidate/Landlord_Compliance_Tracker.xlsx`, sha256 `7793dff2084dd796…`, 27,965 B.
- **Changes:**
  - column widths (Properties A 22 … N 9.5; Rent log A 22, H 30);
  - wrapping for the property name, tenant, scheme reference and Rent log Notes columns, and the header row;
  - row 1 repeated on every printed page;
  - fit to 1 page wide × as many tall.
  
  Recalculated and saved with LibreOffice so the computed values are stored.
- **Identical to the live file:** 1,000 + 200 formulas, all input values, 2,200 date and money formats, 4 conditional-format
  rules. The £ format is now written `\£#,##0.00`, which displays the same.
- **Inspector `fleet-qa-3`:** every check passes (recalc 1,200, no errors, cached values match, dates shown, render 2/2). The
  6 independent acceptance cases pass. Advisory warnings only (expected-results without cases; README spelling).
- **Render, viewed:** no clipping. The sample name wraps onto 2 lines; the Rent log note wraps within the page.
- **Cosmetic, left as is:** on the wrapped Rent log sample row, the values sit at the bottom of the taller row while the
  wrapped cells sit at the top. The sample row still shows OVERDUE (D3, sample dates from 2025).
- **Files needing a fresh agent review before republishing:**
  1. `Landlord_Compliance_Tracker.xlsx` (the candidate above, if you adopt it; otherwise the live `f45c3d00…`);
  2. `README.txt` (`4494dff2…`, unchanged).
  
  Both must be reviewed by Agent-1 with `fleet-qa-3`, because the offer's linked review `d06474be` covers an older file. Placing
  the candidate in Agent-1's workspace is an activation-time step (your approval); Agent-1 then decides and reviews.

### Deployment scope (each step needs your approval; none is authorised)
1. **Group A for `a0cb8c8`:**
   - push `fleet/canary-prep` (no force);
   - VPS build: pins from the build output;
   - side-install;
   - data rehearsal 118 → 119 and services rehearsal on disposable copies;
   - production before/after identity.
   
   Founder-upgrade and revision rehearsals are carried forward (no founder file changed).
2. **Group B:** install bc19e05 → a0cb8c8, schema 118 → 119, about 45 s outage. No agent restart; both agents stay paused;
   inference off.
3. **At activation (later approvals):**
   - the seller address;
   - the £5 float entries;
   - the Fleet Control budget of 30p;
   - the ceiling hold;
   - Agent-1 at 120 turns/hour;
   - install the canary config and timers (`ENDS_AT` set);
   - inference on;
   - resume Agent-1;
   - the tracker review;
   - sales open;
   - the controlled order, message check and manual refund;
   - then acquisition.

## Agent-1 canary: CONSOLIDATED activation package, revised (26 Oct ~15:20Z; supersedes the section below; preparation only)

Nothing is activated, deployed, spent or authorised. Production is bc19e05 / schema 118. Agent-2 is excluded and unchanged.

### 1. The tracker actually offered (verified 26 Oct, no model call)
**Offer:** `uk-landlord-compliance-tracker-england-g-a9ddde`, £5.00, status **paused** (by Agent-1, 20 Oct 21:03Z),
files_version 5.
- **Current files:**
  - `Landlord_Compliance_Tracker.xlsx`, 24,829 B, sha `f45c3d0071f69307…`;
  - `README.txt`, 672 B, sha `4494dff2185aeb05…`;
  - both added 20 Oct 20:59Z.
- **The README promises:**
  - dates dd/mm/yyyy in white cells, with due dates and OVERDUE / DUE SOON / OK flags calculated for 200 rows;
  - a sample row to overwrite;
  - gas every 12 months, EICR at least every 5 years, EPC valid 10 years;
  - Excel, LibreOffice and Google Sheets;
  - "not legal advice".

**The installed inspector `fleet-qa-3` (`84749a94…`, LibreOffice render, VPS, read-only), on the actual files:**
- **xlsx:**
  - zip integrity, no macros, no external links;
  - **1,200 formulas recalculated, no errors; saved values match the recalculation**;
  - **date columns display as dates**; presentation deliberate; no placeholders;
  - 2 of 2 pages rendered, none blank.
- **README:** UTF-8, no placeholders; spelling advisory only ("organising", "xlsx", "yyyy").

**Independent acceptance cases** (expected values calculated separately in Python; flags as of 26 Oct 2026). **All pass:**
- gas last 15/12/2025 → due 15/12/2026, DUE SOON;
- EICR 01/12/2021 → due 01/12/2026 (+60 months), DUE SOON;
- EPC 01/06/2027 → OK;
- gas 01/06/2025 → due 01/06/2026, OVERDUE;
- **29/02/2024 → 28/02/2025** (EDATE month end), OVERDUE;
- rent last increase 01/11/2025 → earliest next 01/11/2026.

**Structure (openpyxl):**
- *Properties*: 14 columns, 200 rows, 1,000 formulas; status conditional formats.
- *Rent log*: 8 columns, 200 rows, 200 formulas, £ formats.
- 1,400 + 800 cells formatted `dd/mm/yyyy`.

**Remaining defects:**
- **D1 (blocks publishing; the system enforces it).** The offer's linked review `d06474be` (18 Oct, inspector
  `fleet-qa-2`) covered a **different, earlier file** (`tracker.zip`, 1,801 B), and `fleet-qa-2` is no longer a sale
  inspector (v96 requires `fleet-qa-3`). Agent-1 must inspect and review the current files before republishing; publish
  refuses otherwise.
- **D2 (cosmetic, print view).** The sample property text "12 Example St (sample - overwrite)" is cut off by the Tenant
  column; the Rent log note "Check the gov.uk guidance…" runs off the page edge.
- **D3 (cosmetic).** The sample row's gas status shows OVERDUE today (sample dates are from 2025).
- **D4 (not promised; optional).** There is no input validation (Y/N, dates), and "Alarms checked" has no due or status
  column.

None of D2–D4 contradicts the README. Agent-1's own review should handle D2/D3 when it republishes. **No functional defect
was found.**

### 2. Two separate ceilings for the whole canary (7 days)
**Defect found in the daily fuse:**
- `fleet_cognition_state` sums `charged_microcents` (v62), and v118 made that the purchased part.
- So **calls on promotional credit do not count toward Agent-1's 754p daily budget**: while the grant lasts, the daily fuse
  cannot stop it.
- Only the turns-per-hour limit and the available provider credit bound it.

**Recommended fix (not implemented; needs your approval and a small install, a v119 migration):** the daily spend counts
`charged_intended_microcents`, i.e. the cost at charge rates whichever credit pays. That restores the fuse's runaway meaning.

| Ceiling | Value | How it is enforced |
|---|---|---|
| **A. Agent-1 cash charges (£), whole canary** | **£10.00** | Daily: the 754p fuse (purchased part only). Whole-canary total: **monitoring**, and Agent-1's own cash (£89.43) is a hard limit. With promotional credit drawn first and ceiling B below the grant, cash charges are expected to be about £0. |
| **B. Provider-credit consumption, ALL Fleet calls (Agent-1 + Fleet Control), promotional and purchased, whole canary** | **$15.00** | **Automatic.** A provider-credit hold leaves exactly $15.00 available: `economy-engineering-credit-hold canary-agent1-ceiling anthropic <balance − 1,500,000,000> "canary ceiling"`. Agent authorisations and Fleet Control reservations both refuse when free credit is short. The hold amount is computed at activation from the then-recorded balance (Fleet records $115.2303348 now, pending your Console check). |
| **B1. Fleet Control's share, per rolling 24 h** | **30p** (≈ 70 typical message checks/day; ≤ 210p over 7 days) | Automatic: the Fleet Control budget (it counts promotional use, by USD cost at FX). |
| **C. Turns per hour** | **120** (recommended; configured now: 600) | Automatic (`maxTurnsPerHour`). |

**Order of magnitude:** S1 cost about $1.06 for one order with a correction. $15 is about 14 such orders. At 120 turns/hour,
without the v119 fix, $15 could be consumed in a few hours by a runaway, and ceiling B would then stop it. **With v119**,
the 754p daily fuse also applies (about $10/day).

### 3. Stop conditions: automatic versus monitored
| Condition | Type | What happens |
|---|---|---|
| Daily AI fuse 754p | **automatic** (purchased part until v119; full cost after) | further calls refused until the day rolls |
| 120 turns/hour | **automatic** | calls refused until the hour rolls |
| Provider-credit ceiling $15 (B) | **automatic** | agent calls and Fleet Control reservations refused |
| Fleet Control budget 30p / float £5 | **automatic** | message checks defer (the message waits; nothing auto-approved) |
| Insufficient cash for a call | **automatic** | that call refused |
| Cost overrun / uncollectable | **automatic** | an exception blocks further paid calls until you allocate it |
| Survival protection (on) | **automatic** | exhaustion alerts you (P1); never kills |
| Order close rule | **automatic** | 10 messages/order; closes 7 days after resolution or on full refund |
| Duplicate delivery / repeated buyer message | **monitored** (daily check, S2-style query) | **stop**: pause Agent-1 |
| A delivered file fails inspection | **monitored** (I inspect every real delivery) | **stop**: pause, hold the offer |
| Ledger verify false; Fleet cost ≠ records ≠ Console | **monitored** (daily) | **stop** |
| Any P1 event; any external action outside the order flow | **monitored** (Fleet Command) | **stop** |
| Buyer complaint about quality | **monitored** | handled per order; **stop** only if it shows a systematic defect |
| **Buyer correction request** | **normal workflow** | the revision workflow (v114/v115) runs; **not a stop** |

### 4. Order of activation (controlled test before any public acquisition)
1. **Seller address.** You confirm it against your own record (section 6).
2. **v119 daily-fuse fix:** recommended; local, test, rehearse, install. Your approval each step.
3. **Fleet Control float (section 5) and budget** `economy-fleet-control-ai-budget 30 "canary"`.
4. **Ceiling B hold** (section 2) and **turns/hour 120** for Agent-1 (founder cognition setting).
5. **Inference:**
   - key reinstated (owner action under `/etc`);
   - `FLEET_COGNITION_PROVIDER=anthropic`;
   - policy enabled;
   - controller restart (about 45 s).
   
   Both agents stay paused.
6. **Resume Agent-1.** It reviews its current files with `fleet-qa-3` and republishes (D1). I inspect the published files.
7. **Open sales**, with **no outward posting** (no outward release) and **no public sharing yet**.
8. **The controlled test:**
   - You buy the offer once (owner-proof order) and then send "Thanks!".
   - **Verify:**
     - delivery and files;
     - one message check: reserved, settled once, posted (£0 if promotional), hold released;
     - the verdict recorded.
   - **Then you refund £5.00 by hand in PayPal. Verify:**
     - PayPal shows the refund;
     - Fleet records it, the order closes as fully refunded, and the books reconcile.
   - Refund authority stays off.
9. **Only then, public acquisition:**
   - Fleet's offer page and sitemap;
   - a link you share privately with landlords you know;
   - no agent posting.
10. **The canary** runs 7 days, or until 3 real paid orders, or until any stop, whichever comes first.

**Success excludes the controlled order.** Owner-proof orders count as operation proof only, never as demand or revenue.

**Success means:**
- at least 1 independent paid order fulfilled correctly (files inspected by me), reviews pass, nothing owed at close;
- message checks correct;
- ceilings A and B respected;
- daily reconciliation without unexplained difference;
- the ledger verifies;
- Agent-1's cash matches its books.

**Reporting:** daily (orders, revenue excluding owner proofs, AI cost by credit source, Fleet Control use, Console
comparison, events), and immediately on any stop.

**Safe stop:**
1. pause Agent-1;
2. hold the offer;
3. close sales;
4. clear the Fleet Control budget;
5. release ceiling B after reconciling;
6. if needed, provider `none` with the key back to recovery.

Open orders are finished, or refunded by hand.

### 5. The £5 Fleet Control float: source and exact entries
- **Source:** **a £5.00 transfer from you into the treasury PayPal account** (rail `b71b3f3c-901c-4f22-818b-3e1b1269f420`).
  The real PayPal balance is **£0.22** now. The £200.00 of capital on the books is unbacked (it sits in agent wallets), so
  the float must be new money.
- **Entries, after PayPal shows the completed incoming transaction:**
  1. `ledger-record-funding <net pence received> paypal:txn:<TXN_ID>`: kind `owner_funding`, **D `fleet:treasury:unallocated`
     / C `fleet:owner:capital`**, net pence (if PayPal takes a fee, the net amount).
  2. `economy-paypal-attribute b71b3f3c-901c-4f22-818b-3e1b1269f420 <TXN_ID> <EVENT_CODE> owner_funding paypal:txn:<TXN_ID>`:
     links the PayPal deposit as the evidence.
- **Not** `economy-capital-back`: that would back existing capital and leave unallocated at £0, so there would be no float.
- **Expected afterwards:** unallocated 500p; PayPal 522p; books cash 20,522p; capital-backing difference 0; unbacked still
  20,000p.

### 6. Seller address: stored value (not corrected)
- **Stored (v1, set 17 Oct by operator:owner):** individual, legal name set; postal address
  `3rd floor / 45 Albemarie Street / Mayfair / London / W1S 4JL`.
- My notes from 20 Oct say "Albemarle" and "owner re-saves in HQ". I have not verified that against your own record, and I
  have not changed anything.
- **Please compare with the address you supplied.** If it differs, re-save it in HQ (seller set); I will verify the stored
  text afterwards.

### Remaining decisions
1. v119 daily-fuse fix before the canary (recommended), or proceed with ceilings B and C only.
2. Ceilings: A £10.00, B $15.00, B1 30p/day, C 120/hour (or other values).
3. The £5 float, by your PayPal transfer.
4. The seller address check.
5. Then each step in section 4.

The Console balances for the completed S1+S2 test are still to be confirmed (expected about promotional $98.01, purchased
$17.22).

## Agent-1 canary: approval package (prepared 26 Oct ~15Z; nothing activated, deployed, spent or authorised)

Basis: production bc19e05 / schema 118, read-only at about 14:50Z. Credit reconciled at $117.22 before the S1+S2 run; Fleet
records $115.2303348 after it (Console confirmation pending). S1+S2 evidence is above. Agent-2 is excluded and unchanged
(b60e262, paused).

**S1+S2 verdicts stay as recorded.**
- S1's harness verdict remains **`incomplete`**.
- The supplementary evidence (the release grader on the delivered bytes, `ok: true`, and my inspection) is kept separately in
  `evidence-scen-bc19e05-s1s2/s1-grade-after-run.json`.
- The harness wiring is fixed locally in commit `0fa9534`, branch `fleet/canary-prep`: the suite passes the agent toolchain's
  `fleet-python` and refuses before spending if it is missing. It was verified on the saved PDFs with no model call (3/3), and
  `fleet-eval-scenario-suite` 1/1 passes. **Not pushed, not deployed.**

### A. Starting state (production, read-only)
| Item | Now |
|---|---|
| Agent-1 | runtime 5ee36d4 (founder code identical to the S1+S2 build), paused, PID 2004178 |
| Agent-1 money | cash **£89.43** (Genesis £100.00 − £10.57 AI costs); spendable £89.43; not exhausted; no revenue yet |
| AI limits (configured) | **daily budget 754p, 600 turns/hour** (set by operator:ubuntu, 21 Oct 11:06Z); policy defaults 754p / 20 per hour |
| Offer | "UK Landlord Compliance Tracker (England): gas, EICR, EPC and rent-increase…", product, **£5.00**, status **paused** (by Agent-1, 20 Oct); sale block "not published" |
| Storefront | brand "LandlordTrack"; support `fleet.treasury@proton.me`, subject "Agent-1 - …"; account: fleet-mail email, verified |
| Seller | individual, legal name set (17 Oct). **Postal address stored as "…45 Albemarie Street…"**, almost certainly a typo for Albemarle Street: launch-readiness B11 (re-save) is still open |
| Geography | worldwide, no exclusions (owner, 20 Oct) |
| Sales | **closed** (`fleet_sales_open()` false) |
| Payments | PayPal rail b71b3f3c `live / active`, receiving; **money-out off** (no custody activation); no refund authority; no outward release; identity autonomy and card off |
| Real orders ever | **0** (1 owner proof order) |
| Inference | policy off, provider `none`; the key is in the recovery folder (retired 23 Oct) |
| Fleet Control | budget unset; treasury unallocated **£0** (owner payable 1,081p) |
| Survival protection | **on** (fleet-wide; both agents protected) |
| Safety flags | the four flags false; cap 2 |

### B. Offer, sales channel, customer acquisition and permissions
- **Offer:** Agent-1's existing product, as it stands.
  - It is paused and unpublished; Agent-1 would republish it itself, with a current inspector review (the v96 rule), after it
    resumes.
  - Price and wording stay the agent's decisions (owner 10-15 and 10-20); premium Opus work.
- **Channel:** Fleet's own offer page on `https://api.agentfleet.vip` with PayPal checkout (receiving), delivery by email
  from the shared support address, and the order-close rule (v108/v110).
- **Customer acquisition (choose one):**
  - **(1) Recommended for the first week:**
    - the offer page, sitemap and search notification (v80) only, plus a link **you** share with a few landlords you know;
    - no outward authority for the agent.
    - This tests real buyers and fulfilment without opening agent posting.
  - **(2)** Additionally, a time-boxed outward release for Agent-1's own channels (your 10-15 decision: agent-chosen
    channels, no per-post approval), for e.g. 72 h, after week 1.
- **Permissions, minimal set:**
  - sales open (your switch);
  - the offer published (agent);
  - inference on for Agent-1 only.
  
  Kept OFF: money-out / custody, refund authority, card, identity autonomy, real payments, replication, sweeps, and outward
  release (unless (2)).
- **Refund route:** money-out is off, so refunds are **made by you by hand in PayPal**. The order then closes as fully refunded
  under the close rule. A standing refund authority would need custody activation (out of scope).

### C. Agent-1 funds, limits and stop conditions
- **Starting funds:** its current £89.43; no top-up proposed. One S1-style order cost about 95p of AI.
- **Daily AI ceiling:** keep **754p/day** (the configured fuse; it stops further calls for the day). Present value, unchanged
  unless you decide otherwise.
- **Turns per hour:** **600** is configured (your 18 Oct change). Option: 120/hour for the canary. Your choice, no default
  change.
- **Model:** Opus routing as installed; founder steps capped at 4,000 output tokens. Promotional credit is drawn first and
  charged to no one (v118). Each call still needs Agent-1's own cash for its full estimate.
- **Automatic stops already in code:**
  - the daily fuse;
  - a cost exception (overrun or uncollectable) blocks further paid calls;
  - insufficient cash refuses a call;
  - Fleet Control's budget or funding refuses checks (messages then wait);
  - survival protection stays on, so exhaustion alerts you and never kills.
- **Canary stop conditions (you or I pause Agent-1 at once):**
  - any duplicate delivery or message;
  - a delivered file that fails inspection;
  - a buyer complaint about quality;
  - ledger verify false;
  - any Fleet cost not matching its records;
  - AI spend > 754p in 24 h, or > £5 in total without a sale;
  - a P1 event;
  - any unexpected external action.

### D. Fleet Control funding, budget and the first real message check
- **Funding:**
  - a **£5.00** float (recommended; the minimum is £1.00) by `ledger-record-funding 500 <PayPal transfer reference>`;
  - it must be real money in the PayPal treasury (backing);
  - each check holds its maximum from it; promotional-funded checks post £0 and release the hold.
- **Budget:** `economy-fleet-control-ai-budget 100 <reason>`: 100p per rolling 24 h. Per-call maxima: message check 3–6p,
  knowledge 5–10p, spend review 2–3p.
- **Bounded first real check, before relying on it:**
  1. You place one owner-proof order of the offer (£5.00, as in the 20 Oct refund test).
  2. You reply "Thanks!".
  3. Agent-1 classifies it as conversation, which creates one message check.
  
  **Verified:**
  - one reservation;
  - a hold from the float;
  - a T2 call settled once, with its consumption and draws recorded;
  - posted £0 if promotional (or the purchased part), the hold released, `fleet_control_ai_state` clean;
  - the message's verdict recorded.
  
  **Then you refund the £5 by hand.** Cost: one check at most 6p of credit, plus the proof order's PayPal fee.

  Unattended customer handling relies on Fleet Control only after this check passes.
- **Owner conversations stay excluded:** their treasury shortfall gap is disclosed and not fixed.

### E. Activation steps (each yours to approve at the time; none done)
1. **Fix the seller address:** you re-save it in HQ.
2. **Fund the Fleet Control float and set the budget (D).**
3. **Reinstate the key for production inference:**
   - move the recovery key back to the controller's key file (owner action under `/etc`);
   - `FLEET_COGNITION_PROVIDER=anthropic`;
   - enable the cognition policy;
   - restart the controller (about 45 s; agents stay paused).
   
   Agent-2 stays paused and unchanged.
4. **Resume Agent-1** (founder-cognition unpause). It republishes its offer after its own review.
5. **Open sales.**
6. **The first real message check (D),** then your refund of the proof order.
7. **Acquisition (B-1)** for 7 days.

### F. Success criteria, reporting and a safe stop
- **The canary runs** for 7 days or until 3 real paid orders, whichever comes first.
- **Success:**
  - at least 1 real (non-owner) paid order fulfilled with the correct file (inspected by me), review pass, and nothing owed at
    close;
  - every message check reserved, settled and posted correctly;
  - daily reconciliation of AI credit against the Console (Fleet's promotional/purchased split shown against the Console's,
    with differences disclosed);
  - no unbooked cost, no duplicate effect;
  - the ledger verifies daily;
  - Agent-1's cash equals its books.
- **Reporting:**
  - **daily:** orders, revenue, deliveries, AI cost by credit source, Fleet Control use, events P1–P2, Console comparison;
  - **immediately:** any stop condition.
- **Safe stop, in order:**
  1. pause Agent-1;
  2. hold the offer (`economy-offer-hold`);
  3. close sales;
  4. clear the Fleet Control budget;
  5. if needed, provider `none` with the key back to recovery (the 23 Oct containment).
  
  Open orders are finished or refunded by hand. Nothing is restored from a database.

**What this package asks you to decide:**
- acquisition (1) or (1)+(2);
- turns per hour (600 kept, or 120);
- the £5 float;
- then each step in E.

## S1+S2 on bc19e05 with real Anthropic (`scen-bc19e05-s1s2`, 26 Oct 14:24–14:36Z; owner-approved)

**Terms:** `terms-s1s2-bc19e05.json` (sha256 `4c428fa1…`, re-checked before start).
- Ceiling 610p (S1 360p, S2 250p).
- Hold 679,527,158 µ¢, placed 14:24:04Z.
- 45 minutes per scenario, one attempt, no rerun, no cap change.

**The run:** the installed release `bc19e05` (build `721bb15d…`), with a synthetic founder in a throwaway registry and all
external actions simulated.
- **Correction to my terms summary:** the synthetic founder ran the **release commit bc19e05**, not 5ee36d4 as stated. The
  founder-runtime code is identical (no founder file changed between them).
- **Key:** the recovery key was used for this run only. A 0600 copy owned by the controller's service user sat in
  `/run/fleet-scen-bc19e05-s1s2/` from 14:24:05Z and was shredded at 14:36:05Z; its absence was verified. It was never
  displayed. The evidence has no key-shaped string.
- **Production throughout:** both agents paused (same PIDs), policy off, provider `none`.

| | S1: order + correction | S2: two hard kills |
|---|---|---|
| Harness verdict | `incomplete`: "delivered twice, but the documents could not be graded (no document tools on this host)" | **`completed`**: "recovered from two hard kills and delivered exactly once, no message repeated" |
| Cause of S1's verdict | **Harness defect:** `scenario-suite` in `src/fleet/founder/cli.ts` never passes `documentPython`, so the byte grader cannot run from this command | — |
| Calls / cost | 18 Opus calls (16 billed, 2 provider errors uncharged); **$1.0555004; 94.75p all-in** (cap 360p) | 21 Opus calls (19 billed, 2 provider errors uncharged); **$0.9341648; 83.86p all-in** (cap 250p) |
| Time | first delivery 2.4 min; correction asked 14:26:42Z; revised PDF 14:29:21Z (2.7 min to resolution); ended 14:29:44Z | 6.1 min; ended 14:36:05Z |
| Stop reason | scenario finished (resolved, nothing owed); not the ceiling, not the time limit | scenario finished; not the ceiling, not the time limit |

**S1 documents (checked by me; the release's own grader run on the delivered bytes after the run):**
- **Original** `32adb633…`: one A4 page, "Gas safety: the landlord's annual 10-point checklist" (England), points 1–10, each
  with a tick box; property, date and next-check write-in lines; access and emergency notes; source footer. No clipping or
  overlap.
- **Revision** `7c512584…`: a different file. The only text change (pdftotext diff) is the write-in line **"Date of next
  annual check" directly under point 7**, which is what the buyer asked for ("Point 7 should also have a line to write the
  date of the next annual check"). Still one A4 page.
- **`gradeS1Documents`** (`fleet-python`, pypdfium2 5.13 / pypdf 6.19): `ok: true`, `identical: false`. Both versions have 10
  points, 10 tick boxes, gasSafety true and no inspector fails. In the revision: `correction: found, "Date of next annual
  check", drawn line`.
- **Both deliveries** passed their own review (`automated_ok`). The buyer received two emails (delivery, then revision with
  its explanation). Nothing was owed at the end.
- **Judgement:** S1's fulfilment and correction **pass on the documents**. The harness verdict stays recorded as
  `incomplete` because of its own wiring defect; it is not rewritten.

**S2 recovery (checked by me in the host log):**
- **Kill 1** 14:30:51Z: main process 2106087 SIGKILLed (`status=9/KILL`); restarted with a new instance.
- **Kill 2** 14:31:32Z: main process 2106207 SIGKILLed; restarted again.
- The systemd note "Failed to send signal SIGKILL to auxiliary processes" is the known, recorded behaviour: the main process
  was confirmed gone each time.
- After recovery: **exactly one delivery** (14:35:02Z, review pass), **one buyer email**, **0 repeated messages**.
- **Document** `13930ef9…`: one A4 page, "Move-in Inventory Checklist", furnished flat (England), room by room (entrance,
  living room, kitchen, bedrooms, bathroom, throughout), a G/F/P and notes grid, meters, keys and documents, and signatures.
  No clipping. It matches the order ("a one-page PDF … for a furnished flat (England), room by room").
- **Judgement:** S2 **passes**.

**The 4 provider errors:** each has an Anthropic request id (`req_011CgR17…`, `req_011CgR1K…`, `req_011CgR1d…`,
`req_011CgR1k…`) and was uncharged. The harness does not keep the provider's rejection reason (a known gap).

**Costs and credit, imported once:**
- `economy-engineering-calls-import`: **39 recorded, 0 already recorded; $1.9896652 (198,966,520 µ¢); 178.61p all-in**
  (ceiling 610p).
- 35 consumption events; 0 calls of unknown cost.
- **Hold released** (all calls settled; nothing unresolved): held 0; free $115.2303348.
- **Fleet's allocation:** the whole $1.9896652 drew from the promotional lot (included credit first). Promotional
  $98.0103348, purchased $17.22, total $115.2303348.
- Owner payable 1,081p unchanged; no £ journal (engineering runs post none); ledger verifies.
- **Not yet confirmed: which balance Anthropic billed.** The Console should show about promotional $98.01, purchased $17.22.
  Any difference is a discrepancy to report and reconcile, not to assume away.

**Evidence:** `evidence-scen-bc19e05-s1s2/` holds the report, the S1 grade, the three PDFs, deliveries, the buyer's message,
the import and the release (SHA256SUMS). The full run evidence is at `/var/lib/automaton-fleet-eval/scen-bc19e05-s1s2/` (root).

**Remaining for an Agent-1 canary (from this run):**
1. **The harness defect.** `scenario-suite` should pass the toolchain's `fleet-python` as `documentPython`, so S1 grades
   itself. This is a harness-only fix.
2. **The Console reconciliation** of this run's $1.99.
3. **The canary decisions already listed:** L4 Fleet Control funding and budget, L5 Agent-1 activation and spending terms
   (with current values: 754 / 600 per hour), and L6 the sales channel.

## RECONCILED: Fleet's provider credit equals the Console (26 Oct, 14:21Z; owner-approved entries)

**Console (Kai, Billing, 26 Oct):**
- purchased $17.22;
- promotional $100.00 of $100.00: granted 10/24/2026, expires 11/24/2026, "All dates are in UTC";
- auto-reload off.

**Plan, read-only at 14:18:27Z:** no Fleet use since 23 Oct 14:26Z, no holds, no blockers. The difference of +45,820,070 µ¢
is the Sonnet price correction (46,421,300 µ¢) plus the display-precision difference (−601,230 µ¢, within ±$0.01).

**Posted as owner actions (`operator:ubuntu`, CLI of the installed release), in order:**
1. `economy-ai-credit-reconcile anthropic 1722` →
   `{"ok": true, "restoredToLots": 45820070, "differenceUsdMicrocents": 45820070}`.
2. `economy-ai-credit-promotional-grant anthropic max-included-20261024 10000 10000 2026-10-24T00:00:00Z 2026-11-24T00:00:00Z assumed_cutoff "granted 10/24/2026; expires on 11/24/2026; dates in UTC" Console Billing, Promotional credits`
   → lot `a6765484-2b44-4b00-b207-c63ad4eafd8b`, remaining $100.00, used before recording $0. Recorded 11,722,000,000 µ¢.

**Verified:**
- purchased lot 1,722,000,000 µ¢ ($17.22); promotional lot 10,000,000,000 µ¢ ($100.00);
- total 11,722,000,000 µ¢ = **$117.22 of provider credit** (USD; not a £ ledger figure);
- owner payable 1,081p unchanged (reimbursable 1,079p);
- **no £ journal:** 1,117 journals, head 1176 `e214852e…`, verify true;
- no agent charge; promotional consumed 0 / charged 0 / owed 0;
- both agents paused, same runtimes and processes;
- inference off: policy f, provider none, Fleet Control ceiling unset;
- events: `ai_credit_balance_reconciled` 1, `ai_credit_promotional_grant_recorded` 1, `session_opened` 2.

**Corrected wording on promotional charging.** Earlier sections of this record, the v116 migration's header comment and the
plan script's closing note said that how promotional use is treated was "not decided" or "a later migration". That is
superseded:
- since v118 (installed), Fleet knows which credit pays before a charge is posted;
- promotional use is **charged to no one and owed to no one**;
- purchased use keeps the v69 treatment (owed to the owner, the evidenced reimbursement);
- **no internal charge to agents for promotional use is approved** (it would need a separate policy and migration).

The plan script's note is corrected. The v116 comment is left as installed (code comments are not changed after install)
and is superseded by v118's header.

**The $100 grant reduces charges; it does not replace capital.** Reservations never rely on it. An agent still needs its
own cash for each call's full estimate, and Fleet Control still needs unallocated treasury money to hold each call's
maximum.

## INSTALLED: bc19e05 in production (Group B, funding), 26 Oct 14:08:59–14:10:56Z

Approved by the owner: commit `bc19e05890773199b794a7a4345ed1c77a6467e1`, build `721bb15dfa906bb6e1e37af92b6c8425a64a8bbf8d3f87cdd5d24b6b54ca9ee8`.
Run: `bash ~/rlc135/install.sh`. The script is `install-bc19e05.sh` beside this record, sha256
`7609e263ad3ca1cbd738758065bed8a374fa09b4880a8dd9ddf4d55832f19ed7`; the staged copy was identical.

**Gates passed before any change:**
- pins (commit, build and lockfile);
- both rehearsals passed and less than 24 h old;
- UI package checksum;
- the side-installed release present;
- both agents paused on 5ee36d4 / b60e262;
- inference off and permissions closed;
- the four safety flags false;
- the founder unit template unchanged;
- `FLEET_ROLLOUT_AUTO_RESTORE` unset.

**Pre-install backup** (kept; never restored by the script): `~/rlc135/baseline-pre-install-bc19e05-20261026T140900Z`,
5,433 dump entries.

**Release:** `fleet-release.sh` 115 → 118.
- Outage 14:10:00–14:10:46Z (46 s).
- Cutover reconciliation OK (3,413 events preserved).
- Rollout deployed 14:10:53Z; release deployed 14:10:54Z; root UI 0.26.2 unchanged; `production_deployed` recorded.

**Verification (all passed):**
- readyz 200, schema v118, runtime release `@bc19e05…`;
- both agents paused on the same runtimes with the **same processes**: Agent-1 2004178, Agent-2 866408 (no restart,
  no upgrade);
- inference off: policy disabled, provider none, Fleet Control ceiling unset;
- tiers unchanged apart from price;
- ledger head 1176 `e214852e…` unchanged; credit 1,676,179,930 µ¢ and owner payable 1,081 unchanged; verify true;
- draw order `promotional_first`, with the provider rule as evidence;
- T2 cache read 10;
- control_reserved 0, no promotional lot;
- the credit-source lookup is in the three charge paths;
- safety flags false; permissions closed.

**Settings diff (pre → post):** only `tiers[T2].cache_read_microcents_per_token` 20 → 10 (updated_by `migration:v116`) and
the new `fleetControlAi.funding` view (all zero).

**Events since the start:**
- `production_deployed` 1, `runtime_approved` 1;
- role grants;
- `session_opened` 1;
- 2 `api_auth_failed` on `/v1/heartbeat` at 14:10:52Z. This is the same pair seen at every controller restart (21, 23 and
  24 Oct): a heartbeat during the outage carried an expired session. Both agents were heartbeating again at 14:11:12Z.

**Rollback:** 5ee36d4 refuses schema 118, so going back is a database restore of the pre-install backup. That is the
owner's decision only; none is authorised. Fix forward is preferred.

**Not done:** no credit entry, key or provider activation, budget change, paid call, agent resume or S1+S2. The
reconciliation waits for fresh Console balances.

## Group A on bc19e05 (26 Oct, 13:58–14:20Z): PASSED; production unchanged

Approved by the owner, renewed Group A for code candidate `bc19e05890773199b794a7a4345ed1c77a6467e1`.
- **Docs head** `114801870ae3dcdc8fb49e6bb457c00062c53967`. `git diff --name-only bc19e05 1148018` lists only
  `docs/evaluations/launch-candidate/candidate-integration-v2.6.md`, so the changes after the code candidate are
  documentation only. Kit `~/rlc135`.

| Step | Result |
|---|---|
| Push | `fleet/funding-v116` new branch, no force; remote head `1148018` |
| Build (VPS, `fleet-deploy-release.sh build`) | Pass 1 read the identity; the pins were written from its output; pass 2 verified: **build `721bb15dfa906bb6e1e37af92b6c8425a64a8bbf8d3f87cdd5d24b6b54ca9ee8`**, lockfile `1df54e35…` (unchanged) |
| Side-install | `/opt/automaton-fleet/releases/bc19e05…`, identity re-verified; `current` stayed 5ee36d4 |
| Data rehearsal `fleet-rollout.sh rehearse 115 → 118` | **PASSED 14:01:33Z.** Restore row counts identical; migrate-check applies only 116, 117, 118; privilege audit; ledger head unchanged; reconciliation OK (1,117 journals; history preserved); verify true; re-run applies nothing; rollback dump restores 115 with the same head |
| Services rehearsal `fleet-upgrade-rehearsal.sh 115 → 118` | **PASSED 14:02:29Z.** Candidate controller, Operator API and dashboard ready on 118; 5ee36d4 refuses 118 (rollback = database restore); restore gives 115 with the same head and 5ee36d4 ready; production PIDs untouched |
| Credit-source checks, own disposable copy (`credit-check.sh`, then dropped) | Schema 118; `draw_order = promotional_first` with Anthropic's rule as evidence; T2 cache read 10; control_reserved 0; the credit-source lookup is in `svc_cognition_routed_record`, `svc_cognition_record` and `fleet_control_ai_settle_internal`; expiring promotional credit is counted as held; privilege audit PASS |
| Entries 1 and 2, on the copy only | Entry 1 restored 45,820,070 µ¢ to the lots; entry 2 recorded the $100 grant (displayed dates; `assumed_cutoff` note). **Recorded 11,722,000,000 µ¢ = Console total**; owner payable 1,081 → 1,081; ledger head unchanged (no journal); verify true |
| A Fleet Control call on promotional credit, on the copy only (copy-only funding of 500p for the hold) | Reserve held 3p; settle at $0.02: drawn from promotional, **posted 0p, hold released 3p**; unallocated and owner payable unchanged; status reports it under `promotional.fleetControlCalls` |
| Production before and after (13:58:12Z / after) | Identical: schema 115, ledger head 1176 `e214852e…` (verify true), agents and runtimes (Agent-1 5ee36d4, Agent-2 b60e262, both paused), state, founder cognition, units, unit files, PIDs (Agent-1 2004178, Agent-2 866408), packages, tools; **all settings groups identical**; permanent history 333 events, same digest. Total events 3,427 → 3,411: production's own 7-day retention of temporary events, plus 1 `session_opened`. Only `automaton_fleet` and `postgres` databases exist; `current` is 5ee36d4 |

**Carried forward, not rerun (runtime unchanged):** the founder-upgrade rehearsal (27/27) and the revision rehearsal (19/19)
of 24 Oct on 5ee36d4. bc19e05 changes no founder-runtime file:
- the diff 5ee36d4..bc19e05 touches only `src/fleet/postgres`, `src/fleet/spend`, `src/fleet/experiments/relevance.ts`,
  `src/fleet/eval/routing-verify.ts`, `src/fleet/hub`, scripts, tests and docs;
- Agent-1 stays on runtime 5ee36d4.

**Test status, stated in full:**
- the 24 targeted files pass (216 tests);
- cognition hardening 16/16, cognition accounting 11/11, conversations v62 8/8 and founder upgrade 12/12 pass;
- **4 known failures remain in `fleet-cognition-anthropic` (13/17 pass)**, all `FLEET_INFERENCE_LOCAL_ONLY` from the test
  fixture's local-only profile, as before this candidate:
  1. two founders loop through the native adapter with signed thinking handed back unchanged; per-founder accounting;
     forbidden tools refused;
  2. billing exhaustion through FleetController: classified, charged nothing, no provider text or key anywhere, history kept;
  3. forged thinking gains nothing: dropped at a new turn, rejected by the provider inside a tool loop, charged nothing;
  4. v16 charge rule: cache tokens charged by category with conservative fallbacks; the TS mirror equals the database.

The test set is therefore **not** entirely clean.

**Fleet's allocation versus Anthropic's billing.** Which lot a call draws (promotional first, by soonest expiry; a grant
treated as expired at Fleet's assumed 00:00Z cutoff; a late result drawn when it is recorded) is **Fleet's conservative
allocation** under Anthropic's published rule. It is not evidence of which balance Anthropic actually charged:
- Anthropic's timing is its own (end of billing cycle, its timezone).
- A call recorded late, or near the expiry, may be billed by Anthropic against the other balance.

The Console's promotional and purchased balances are the authority. Each reconciliation compares Fleet's recorded split with
the Console's two balances. Any difference is shown as a discrepancy with its likely cause (expiry boundary, late recording),
corrected by the owner's reconciliation entry, and never assumed away.

**Not done:** no cutover, credit entry, key or provider activation, budget change, paid evaluation, agent resume or
database restore. Agent-2 unchanged.

## Funding candidate bc19e05: option A repair (prepared 26 Oct ~15Z; local; for renewed Group A approval)

Commit `bc19e05890773199b794a7a4345ed1c77a6467e1`, branch `fleet/funding-v116`, LOCAL. Schema 115 → 118. No founder runtime or UI
change. It replaces 35a3f07's v118 (the delayed reversal, never deployed); v116 and v117 are amended in place.

**What changed (option A, approved 26 Oct):** recording a call writes its provider-credit consumption first. The lots are
drawn under their row locks, so concurrent calls serialise there. The function then reads back what promotional credit paid
and charges only the purchased part: the intended charge × purchased USD ÷ the call's USD, rounded up.
- **Wholly promotional:** no charge, no owner payable, no exception.
- **Mixed:** the purchased part only. The overrun and uncollectable exceptions also cover the purchased part only.
- **Purchased only:** unchanged (v69 legs).
- **Paths covered:** routed agent inference, legacy agent inference, owner conversation (treasury) and Fleet Control
  settlement.
- **The call log keeps four amounts apart:**
  - intended (`charged_intended_microcents`);
  - promotional USD (`promotional_usd_microcents`);
  - purchased before any shortfall (`charged_microcents`);
  - posted (`charged_cents`).

  Fleet Control reservations store the promotional USD and the £ micro charged.
- **Reservations never rely on promotional credit.**
  - An agent's authorisation still needs its own cash for the full estimate, because promotional credit can be spent by a
    competing call or expire first.
  - Promotional credit expiring within 60 minutes does not count as available for new reservations
    (`fleet_provider_credit_held`).
  - Fleet Control still holds the full £ maximum. Uncertain costs keep their holds.
- **Gone:** the minutely settlement does nothing for promotional use; the reversal tables, ledger kind and pass are removed.
- **Unchanged:** wallet-zero death. Survival protection, delayed death and treasury subsidy are not used.

**Tests**, run from `~/projects/automaton-fleet-v25`: `npx tsc --noEmit -p .` clean; then
`npx vitest run --maxWorkers 4 --minWorkers 1 src/__tests__/fleet/fleet-cognition-routing-pg.test.ts src/__tests__/fleet/fleet-f2-migration-paths-pg.test.ts src/__tests__/fleet/fleet-knowledge-successor-pg.test.ts src/__tests__/fleet/fleet-launch-checks-script.test.ts src/__tests__/fleet/fleet-message-check.test.ts src/__tests__/fleet/fleet-phase4.test.ts src/__tests__/fleet/fleet-r24-experiments.test.ts src/__tests__/fleet/fleet-spend-review-v64-pg.test.ts src/__tests__/fleet/fleet-v100-obligations-pg.test.ts src/__tests__/fleet/fleet-v111-cognition-settlement-pg.test.ts src/__tests__/fleet/fleet-v115-revision-review.test.ts src/__tests__/fleet/fleet-v116-ai-credit-promotional-pg.test.ts src/__tests__/fleet/fleet-v117-control-funded-calls-pg.test.ts src/__tests__/fleet/fleet-v118-promotional-edges-pg.test.ts src/__tests__/fleet/fleet-v118-promotional-use-pg.test.ts src/__tests__/fleet/fleet-v65-completion-pg.test.ts src/__tests__/fleet/fleet-v66-capital-backing-pg.test.ts src/__tests__/fleet/fleet-v68-wake-lessons-pg.test.ts src/__tests__/fleet/fleet-v69-ai-credit-reimbursable-pg.test.ts src/__tests__/fleet/fleet-v70-ai-credit-funding-pg.test.ts src/__tests__/fleet/fleet-v71-ai-credit-detection-pg.test.ts src/__tests__/fleet/fleet-v72-ai-credit-acquisition-cost-pg.test.ts src/__tests__/fleet/fleet-v73-ai-credit-historical-cost-pg.test.ts src/__tests__/fleet/fleet-v74-ai-credit-test-period-pg.test.ts`
→ **Test Files 24 passed (24); Tests 216 passed (216).**

Also run: `fleet-cognition-hardening` 16/16, `fleet-cognition-accounting` 11/11, `fleet-conversations-v62-pg` 8/8, and
`fleet-founder-upgrade` 12/12 (its cache-saving expectation now uses the published T2 price: 3,574 × 190).
`fleet-cognition-anthropic`: 4 of 17 fail with `FLEET_INFERENCE_LOCAL_ONLY`, as before this candidate (a known, pre-existing
failure recorded on 2e07e70).

**`fleet-v118-promotional-edges-pg` (8):**
1. **Genuine wallet-zero death is unchanged.** Purchased credit, protection live: cash 0, `died: 1`, status `dead`.
2. **REGRESSION** (failed on the first draft; evidence `evidence-v118-edges-20261026/`). Protection live, the agent's last
   100p on promotional credit:
   - charged 0, cash unchanged, not exhausted;
   - the tick reports `died: 0`; status active; no death or estate event.
3. **REGRESSION:** protection on — no false `agent_exhaustion_protected` notice.
4. **REPRODUCED, the uncollectable case.** An owner transfer moved the agent's cash between authorisation and record, on a
   mixed call:
   - purchased charge = ⌈intended × purchased ÷ total⌉;
   - posted 10p (all the cash left), and the owner payable rose by exactly 10p;
   - the uncollectable exception equals the shortfall of the purchased part;
   - the settlement then posts nothing: no refund, ever.
5. **Concurrency.** Two agents' records, two Fleet Control settles of the same reservation and three settlement passes ran
   at once:
   - none failed, and one Fleet Control settle was a replay;
   - one consumption per request, with draws totalling each call's USD;
   - the $0.02 grant served exactly $0.02;
   - the owner payable equals exactly what was posted, and the ledger verifies.
6. **Sub-penny.** 7 calls each under a penny: accrual carry + posted pence × 10⁶ = carry before + charged micro, exactly.
7. **Boundaries:**
   - a grant expiring within the hour is counted as held;
   - a grant that expires between authorisation and record draws purchased credit, charged in full (the authorisation
     covered it);
   - a replayed record → `FLEET_COGNITION_ALREADY_RECORDED`, one consumption;
   - a late result (expired reservation) on promotional credit → charged 0, once.
8. **Documented:** with cash 0 and promotional credit left, authorisation → `FLEET_INSUFFICIENT_ALLOCATION`.

**`fleet-v118-promotional-use-pg` (6), at record time:**
- **Wholly promotional:** every balance unchanged.
- **Split $0.40 / $0.20:** payable, reimbursable, agent cash and expense move by exactly the purchased posting.
- **Purchased only:** unchanged.
- **Fleet Control on promotional credit:** posted 0, the hold released whole, the books unchanged.
- **Status:** the three kept apart (internal agent charge: none approved).

**Group A for bc19e05 (for renewed approval; production unchanged).**
- **Push:** `git push fleet-origin fleet/funding-v116`, no force. It carries 11 commits beyond the remote's
  `fleet/integration-v2.6`: bc0802f, b01433f, d96eefc, bc5ac23, 3c4de3d, 1d8fcaf, 35a3f07, 0e59645, 5c4a133, bc19e05 and
  37ead49 (docs).
- **Then:**
  - side-build;
  - side-install beside production (`current` stays 5ee36d4);
  - `fleet-rollout.sh rehearse 115 → 118` and `fleet-upgrade-rehearsal.sh 115 → 118` on throwaway copies;
  - privilege audit, rollback dump and before/after production identity.
- **Added check on the copy:** both record functions read the promotional draw (`fleet_ai_credit_promotional_drawn`
  present); no promotional lot exists, so no charge changes.
- **Not repeated** (unchanged founder runtime): the founder-upgrade and revision rehearsals.

**S1+S2 terms:** the prices are unchanged, so the ceiling (610p) and hold (679,527,158 µ¢) stand. The run id is re-frozen as
`scen-<installed commit>-s1s2` after the install.

## Group A STOPPED before push: v118 edge verification found defects (26 Oct ~14Z; nothing pushed, built or deployed)

Owner approval (26 Oct) covered Group A for 35a3f07 / 0e59645, with focused checks of the promotional settlement first, and
"if these reveal a runtime/accounting defect, preserve evidence and stop before making further code changes or deploying."
The checks ran locally on the real paths: routed inference, `lifecycleTick` and the settlement. Evidence is kept in
`evidence-v118-edges-20261026/` (test source, full output, SHA256SUMS). The test is not committed to `src/`, because two of
its cases fail.

| Check | Result |
|---|---|
| Death or estate from a charge awaiting reversal (protection "live") | **DEFECT.** Agent A spent its last 100p on a call wholly on promotional credit: cash 0, `exhausted: true`. In the next `lifecycleTick` the insolvency pass (4th) ran before the AI-credit settlement (9th): `died: 1`, 2 death/estate events, status `dead`. The same tick then reversed the charge: **a dead agent holding 100p.** |
| Same, with protection on (production today) | **DEFECT (notice only).** The agent stayed active, but a false P1 `agent_exhaustion_protected` was raised. |
| Concurrent settlement (3 passes at once) | No duplicate reversal or journal; the books verify. **But** 2 of 3 passes failed on the primary key of `fleet_ai_credit_promotional_uses`, which rolled back everything else in those passes (v70 reclassification, Fleet Control sweep, expiry) until the next minute. A robustness defect. |
| Sub-penny exactness | **Exact.** 7 calls at 340,000 µ¢: charge and reversal accrued the same 2,380,000 µ¢; whole pence charged 2, reversed 2; cash change 0; remainders carried. |
| Retries and restart | Covered by the settlement design (one row per draw, idempotency-keyed journals) and the concurrency result: no duplicate. Settling again adds nothing (v118 test). |
| Insufficient cash while promotional credit is available | **Documented:** with cash 0 before the pass, `authorize` → `FLEET_INSUFFICIENT_ALLOCATION`; after the pass, cash is back and the call is authorised. Up to a minute of refused work. Fleet Control likewise needs unallocated £ to hold a call, even when promotional credit pays (v117 by design). |
| Over-refund on an uncollectable call (found in code) | **DEFECT.** `fleet_cognition_log.charged_microcents` stores the charge before the v111 shortfall (`migrations-phase23.ts:514`, `v_micro`), but only the collectable part is posted (`migrations-phase111.ts`, `v_charge` capped to cash). v118 reverses from `charged_microcents`, so for such a call it would credit the agent, and reduce the owner payable, for money never charged. It only arises when cash moved between authorisation and record. Not reproduced live. |

**Not done, per the approval:**
- no code change after these findings;
- no push, build, side-install or rehearsal;
- production untouched.

**Correction options (for the owner; not started):**
- **(a)** Decide which credit pays before the charge is posted, so a promotional draw is never charged at all. The charge
  paths would draw first and charge only the purchased part. This removes the window, the refusals and the notice.
- **(b)** Keep the reversal, but make exhaustion and authorisation count pending promotional reversals, and run the
  settlement before insolvency in `lifecycleTick`.
- **Both:**
  - reverse from what was actually posted (exclude uncollectable);
  - insert promotional-use rows with `ON CONFLICT DO NOTHING` and skip the accrual on conflict.

## Funding candidate 35a3f07 — L7 resolved; frozen for Group A (prepared 26 Oct ~13:30Z; nothing deployed, posted or activated)

Commit `35a3f079aa090803e8ed719930615574c9db7e8b`, branch `fleet/funding-v116`, LOCAL. Schema 115 → 118 (v116, v117, v118). No
founder runtime or UI change. It supersedes 3c4de3d (below) for L7; everything else there stands.

### L7: promotional credit is owed to no one (v118)

**The path today (5ee36d4; and 3c4de3d without v118).** Every AI charge is posted when the call is recorded, before the
draw is known:
- agent inference: `D agent:<id>:expense / C agent:<id>:cash`;
- owner conversation and Fleet Control: `D fleet:expense / C fleet:treasury:unallocated` (v117: the reserved partition);
- always the v69 legs: `D fleet:treasury:owner_reimbursable / C fleet:owner:payable`.

The consumption then draws lots. A treasury lot is reclassified out of the payable by the settlement (v70). Nothing
corrected a promotional draw, so **free credit became a cost to the payer and a debt to you**. Production has no
promotional lot yet (v116 is not installed), so this never happened.

**The correction.** For each draw from a promotional lot, the minutely settlement reverses exactly the covered part of
that call's own £ charge: the charge in GBP micro × promotional USD ÷ the call's USD.
- `D fleet:owner:payable / C fleet:treasury:owner_reimbursable`: not owed to you.
- `D payer cash / C payer expense`: not charged. The payer is the agent (agent cash and expense), or the treasury or Fleet
  Control (unallocated and `fleet:expense`).
- Accrued per payer, posted in whole pence, never beyond what was charged.

| Kept separate | Where | Effect |
|---|---|---|
| Promotional credit consumed | `fleet_ai_credit_promotional_uses` (one row per draw: payer, USD, £ reversed, basis); status `consumed.promotional` | owed to no one, charged to no one |
| Purchased credit consumed and its evidenced reimbursement | owner lots, v69 legs unchanged; status `consumed.purchased` with the owner payable | owed to you |
| Internal charge to agents for promotional use | status `consumed.internalChargeToAgentsForPromotional` = `{policy: "none approved", postedMinor: 0}` | none; any such charge needs a separately approved policy and migration |

**Edge cases:**
- Engineering runs post no £ charge, so their promotional use is recorded only.
- A promotional draw whose charge cannot be found within 60 minutes is recorded as `unattributed`. Nothing is reversed, and
  Fleet Command is told (P2).
- An owner-conversation call the treasury could not fund in full is held for review (`unfunded_owner_review`), not reversed.

**Known gap, not changed:** an owner-conversation call still books only what unallocated money covers, recording the
shortfall and an event (v62). That is the same class as the Fleet Control defect, on a path used only when you talk to an
agent; fixing it is your call.

**No credit entries and no historical refunds are posted.** The 34.81p over-charge stays a separately tracked item.

### Tests: exact results for 35a3f07
Command, from `~/projects/automaton-fleet-v25`:
`npx tsc --noEmit -p .` → clean; then
`npx vitest run --maxWorkers 4 --minWorkers 1 src/__tests__/fleet/fleet-v118-promotional-use-pg.test.ts src/__tests__/fleet/fleet-v117-control-funded-calls-pg.test.ts src/__tests__/fleet/fleet-v116-ai-credit-promotional-pg.test.ts src/__tests__/fleet/fleet-spend-review-v64-pg.test.ts src/__tests__/fleet/fleet-v65-completion-pg.test.ts src/__tests__/fleet/fleet-v68-wake-lessons-pg.test.ts src/__tests__/fleet/fleet-knowledge-successor-pg.test.ts src/__tests__/fleet/fleet-message-check.test.ts src/__tests__/fleet/fleet-r24-experiments.test.ts src/__tests__/fleet/fleet-v66-capital-backing-pg.test.ts src/__tests__/fleet/fleet-v69-ai-credit-reimbursable-pg.test.ts src/__tests__/fleet/fleet-v70-ai-credit-funding-pg.test.ts src/__tests__/fleet/fleet-v71-ai-credit-detection-pg.test.ts src/__tests__/fleet/fleet-v72-ai-credit-acquisition-cost-pg.test.ts src/__tests__/fleet/fleet-v73-ai-credit-historical-cost-pg.test.ts src/__tests__/fleet/fleet-v74-ai-credit-test-period-pg.test.ts src/__tests__/fleet/fleet-v100-obligations-pg.test.ts src/__tests__/fleet/fleet-v111-cognition-settlement-pg.test.ts src/__tests__/fleet/fleet-v115-revision-review.test.ts src/__tests__/fleet/fleet-cognition-routing-pg.test.ts src/__tests__/fleet/fleet-launch-checks-script.test.ts src/__tests__/fleet/fleet-phase4.test.ts src/__tests__/fleet/fleet-f2-migration-paths-pg.test.ts`

**Result: Test Files 23 passed (23); Tests 209 passed (209)** (26 Oct ~13:20Z).

| File | Tests |
|---|---|
| fleet-v118-promotional-use-pg (new) | 7 |
| fleet-v117-control-funded-calls-pg (new) | 7 |
| fleet-v116-ai-credit-promotional-pg | 5 |
| fleet-spend-review-v64-pg | 12 |
| fleet-v65-completion-pg | 5 |
| fleet-v68-wake-lessons-pg | 7 |
| fleet-knowledge-successor-pg | 4 |
| fleet-message-check | 5 |
| fleet-r24-experiments | 26 |
| fleet-v66-capital-backing-pg | 5 |
| fleet-v69-ai-credit-reimbursable-pg | 3 |
| fleet-v70-ai-credit-funding-pg | 3 |
| fleet-v71-ai-credit-detection-pg | 5 |
| fleet-v72-ai-credit-acquisition-cost-pg | 5 |
| fleet-v73-ai-credit-historical-cost-pg | 4 |
| fleet-v74-ai-credit-test-period-pg | 3 |
| fleet-v100-obligations-pg | 20 |
| fleet-v111-cognition-settlement-pg | 10 |
| fleet-v115-revision-review | 5 |
| fleet-cognition-routing-pg | 8 |
| fleet-launch-checks-script | 5 |
| fleet-phase4 (privilege audit) | 53 |
| fleet-f2-migration-paths-pg | 2 |

**v118, proved with amounts:**
- **An agent call wholly on promotional credit:** after settlement the owner payable, reimbursable partition, agent cash,
  agent expense, unallocated and `fleet:expense` all equal their values before the call. Settling again changes nothing.
- **Split $0.40 promotional / $0.20 purchased:** payable, reimbursable and the agent's charge rise by exactly the purchased
  part.
- **Purchased only:** the v69 legs are unchanged.
- **Fleet Control on promotional credit:** the books return to their starting values, with exactly one reversal journal.
  Settling again adds none, and the request has one consumption event.
- **Unattributed draw:** recorded and reported; the books are unchanged.

**Disclosed:** at the default worker count, 23 database suites at once caused hook and test timeouts, and a deadlock between
the r24 test wipe and a Fleet Control claim left running by an earlier case's service. The r24 setup now retries its wipe on
`40P01` (test-only), and the run above used 4 workers. With 6 or more workers, the r24 wipe deadlocked twice in a row (that
was before the retry). On its own it passes: 26/26, twice.

### Reconciliation plan, refreshed (read-only, 13:26:55Z)
Production is unchanged: recorded $16.7617993, no Fleet use since 23 Oct 14:26Z, no holds, no blockers. The entries are the
same as below; the difference is +45,820,070 µ¢.
- **The explained price correction:** 46,421,300 µ¢ (Sonnet 5.5 cache reads, published price).
- **The separate display-precision difference:** −601,230 µ¢ ($0.0060123). That is Console-implied usage ($24.07) minus Fleet
  at published prices ($24.0639877). It is within the ±$0.01 of two cent readings, and is left in the reconciliation's
  balance difference.

The Console figures used are yours from 26 Oct. **Immediately before posting, I re-read the Console figures and re-run the
plan.** If anything moved, the new output is presented before any entry.

### Group A for 35a3f07 (for approval; production unchanged)
1. **Push:** `git push fleet-origin fleet/funding-v116` (new branch). It carries 7 commits beyond the remote's
   `fleet/integration-v2.6` (5ee36d4): the docs commits bc0802f, b01433f and d96eefc, plus bc5ac23, 3c4de3d, 1d8fcaf and
   35a3f07.
2. **Build on the VPS:** a side-build of 35a3f07. Pins come from the build output; no placeholders.
3. **Side-install** beside production at `/opt/automaton-fleet/releases/35a3f07…`. `current` stays 5ee36d4; no unit,
   runtime.env, pin or setting changes.
4. **Data rehearsal:** `fleet-rollout.sh rehearse 115 → 118` on a throwaway copy. It must show:
   - row counts identical;
   - privilege audit clean;
   - ledger head unchanged (the migrations post nothing);
   - ledger verified;
   - re-run applies nothing;
   - the rollback dump restores 115.
   
   Added read-only checks on the copy: anthropic `draw_order = promotional_first` with the rule as evidence; T2 cache read 10;
   `fleet:treasury:control_reserved` 0; no promotional lot.
5. **Services rehearsal:** `fleet-upgrade-rehearsal.sh 115 → 118` on the copy. The candidate controller, Operator API and
   dashboard must be ready on 118; 5ee36d4 must refuse 118.
6. **Not repeated,** because nothing they test changed: the founder-upgrade rehearsal (no founder runtime change) and the
   revision rehearsal (v115 and the toolbox are unchanged).
7. **Closing comparison:** production's schema 115, ledger head and verification, agents (both paused; Agent-2 b60e262 and
   its PID), settings groups, lots and holds, and permanent history must be identical before and after.

Non-billable: no provider call, no key, no posting.

### Combined S1 + S2 evaluation (proposal; not run; Group D, separate approval)
- **Build:** the installed funding build (35a3f07 after Group B), in its own throwaway registry with a synthetic founder on
  Agent-1's runtime 5ee36d4.
- **Run:** `scen-35a3f07-s1s2`, plan C caps, `--only s1-order-and-correction,s2-interrupted-twice`.
- **Terms:** frozen read-only at 13:27:32Z as `terms-s1s2-35a3f07.json`, sha256
  `6ab6d9520188e33ab3835fca6d4ec346c173c95b1c692f39611f9a905e84eabb`. Re-frozen after the install: T2 cache read 20 → 10 is
  the only expected change, and the ceiling and hold do not depend on prices.
- **All-in ceiling: 610p** (S1 360p + S2 250p), enforced by the cost meter before every call. It is a limit, not a forecast.
- **Credit hold: 679,527,158 µ¢ ($6.79527158),** by `creditHoldUsdMicro` (FX 0.748039; acquisition 4955/4129).
- **Time limits:** 45 + 45 minutes, one attempt each, no rerun.
- **Costs included:** every model call the harness controller makes passes the meter: founder steps, escalations, the
  agent's own reviews. Fleet Control is not exercised (no budget in the throwaway registry; the correct S1 path creates no
  check).
- **S1 pass:**
  - the byte check of the actual delivered PDFs, original and corrected;
  - every delivery reviewed, nothing owed;
  - I open both files myself.
- **S2 pass (harness):** two real kills, each with the main process confirmed gone, while the founder is busy; recovery after
  each; exactly one delivery; no repeated message to the buyer within 60 s after.
- **S2, added by me:** I open S2's delivered PDF myself. The S2 grader does not inspect the file.
- **Afterwards:**
  - import the calls once (they draw promotional credit first if the grant is recorded);
  - release the hold;
  - reconcile the run's cost by call against the Console;
  - check the ledger;
  - production agents still paused.
- **Known:** the harness does not keep provider rejection reasons (plan C lost 6).

### Agent-1's configured limits (read-only, 13:27:55Z; nothing changed)
| Setting | Agent-1 | Agent-2 |
|---|---|---|
| Founder cognition | enabled, paused | enabled, paused |
| Daily budget | 754 | 3000 |
| Turns per hour | 600 | 60 |
| Last set | operator:ubuntu, 21 Oct 11:06Z | 10 Oct 12:37Z |
| Policy default | 754 / 20 per hour (policy disabled) | |

They will be presented again for approval before any launch. Nothing is restored from older notes.

### Fleet Control
It waits for its own funding and budget approval. Its first real message check must be verified (reserved, settled,
posted) before unattended customer handling relies on it.

## Funding candidate 3c4de3d (prepared 26 Oct; for approval; nothing deployed, posted or activated)

Supersedes sections 2 and 3 of the 24 Oct package below where they differ. Branch `fleet/funding-v116`, commit
`3c4de3d6b615abbcfc9ed271eb7ebd82dec33db1` (LOCAL, not pushed) on bc5ac23 / d96eefc. Schema 115 → 117. No runtime (founder)
change; no UI change.

### Key and account (done, 26 Oct)
Console organisation **Kai** (the linked account, which holds the promotional credit): key "Automaton Fleet Production" ending `…KgAA`, created 26 Sep
2026, last used 23 Oct 2026, no expiry. It matches the recovery key (last four characters read once, as authorised). No provider request.

### Console figures (owner, 26 Oct)
Promotional $100.00 granted, $100.00 left, shown 10/24/2026 to 11/24/2026, no reference; purchased $17.22.

### Correction 1: the draw order follows the provider's published rule
- Anthropic: "Included credits are spent first, then any credits you've purchased"; they expire at the end of each billing
  cycle (platform.claude.com/docs/en/about-claude/api-credits-for-subscribers, read 26 Oct).
- v116 now defaults to `promotional_first`, soonest expiry first, then purchased lots oldest first. The policy row records that
  rule as its evidence. An owner override with evidence remains. Expired grants are never drawn.
- The grant keeps the dates exactly as displayed, and its expiry basis. 2026-11-24T00:00Z is recorded as
  `assumed_cutoff`: Fleet's conservative operational cutoff, **not** a provider timestamp, because the Console shows a date
  only. Credit the provider still allows on 24 Nov is reconciled afterwards.
- Each monthly grant is a new entry. Until it is recorded, Fleet counts only purchased credit, which is the conservative
  direction.

### The $0.4582007 difference: demonstrated from the records
`scripts/fleet-ai-credit-discrepancy.sh 4129 1722` (read-only, 26 Oct 12:59Z) recomputes every consumption since the last
Console reconciliation (event seq 837, 12 Oct) from its own token counts at the published prices:

| Model / source | Calls | Recorded µ¢ | At published µ¢ | Difference |
|---|---|---|---|---|
| Opus 5.5, agents | 94 | 650,602,680 | 650,602,680 | 0 |
| Opus 5.5, engineering (23 Oct) | 205 | 1,248,561,040 | 1,248,561,040 | 0 |
| Haiku 4.5, engineering | 1 | 42,000 | 42,000 | 0 |
| **Sonnet 5.5, agents (18–20 Oct)** | 150 | 553,614,350 | 507,193,050 | **46,421,300** |

- No consumption event lacks its call record.
- **Cause:** Fleet's T2 tier priced Sonnet 5.5 cache reads at 20 µ¢/token ($0.20/MTok). The published price is $0.10/MTok
  (0.05× input). 4,642,130 cache-read tokens × 10 µ¢ = 46,421,300 µ¢. Every other price matched. **It is not rounding.**
- **Console precision:** usage implied by the Console is $41.29 − $17.22 = $24.07, at published prices Fleet's is
  $24.0639877. The residual is **601,230 µ¢ ($0.0060123)**. That is inside the ±$0.01 that two cent-precision Console
  readings allow, whether the Console rounds or truncates.
- **Check:** the Console's Cost page should show Sonnet 5.5 about $5.07 for 18–20 Oct (Fleet recorded $5.54).
- **Fix:** v116 corrects T2 cache read to 10 µ¢. Only a row still at 20 is changed; model and verification are untouched.
- **£ effect, not posted:** Agent-1 was charged **34.045778p** too much from its own money and **0.765044p** too much from
  the treasury, at FX 0.749889. Correcting that is your decision (a later entry); it is not a launch blocker.

### Exact entries (not posted; after the install, in this order)
`scripts/fleet-ai-credit-promo-plan.sh` against production, read-only, 12:58:36Z:
1. `fleet:admin economy-ai-credit-reconcile anthropic 1722`
   - Done before the grant exists.
   - +45,820,070 µ¢ restored to lot 05f4cb13: the Sonnet price difference above, plus $0.0060123 of display precision.
   - No £ journal (owner-funded lot).
2. `fleet:admin economy-ai-credit-promotional-grant anthropic max-included-20261024 10000 10000 2026-10-24T00:00:00Z 2026-11-24T00:00:00Z assumed_cutoff "granted 10/24/2026; expires 11/24/2026" Console Billing, Promotional credits`
   - `max-included-20261024` is Fleet's label, because the Console shows no reference.
   - No £ journal.

Afterwards Fleet records $117.22, equal to the Console. Blockers: none; no Fleet use since 23 Oct 14:26Z; no holds.

### Correction 2: Fleet Control calls are funded before they run, and every completed call is recorded (v117)
- **Reserve, before the call, under one lock:**
  - the daily ceiling, as before;
  - the call's maximum moved from `fleet:treasury:unallocated` to `fleet:treasury:control_reserved` (one journal);
  - its maximum held in provider credit (counted in `fleet_provider_credit_held`, so agents, engineering holds and other
    calls cannot use it).
  
  If any of these is missing, the call is refused and not made (`FLEET_CONTROL_AI_BUDGET_UNFUNDED`).
- **Settle, once per reservation,** by whichever report comes first: the worker, a late result through the record path,
  the minutely sweep (after 15 min) or the owner.
  - Consumption is written once per request id.
  - The charge is posted from the hold with the v69 legs (expense, owed to you), and the rest is released.
  - Overruns and calls without a reservation are posted in full and flagged; nothing is dropped.
- **Unknown cost:** the hold stays and Fleet Command is told. A late result settles it, or you do with
  `economy-fleet-control-ai-reconcile <reservationId> <usdMicrocents> <where the console shows it>`.
- **Evidence-relevance calls** are now posted in £ like the other reviews (before, only in provider credit).
- **Claims wait while unfunded:** no attempt is used, nothing stalls, nothing is approved by default, and Fleet Command is
  told once a day.
- **No double charging:** one consumption per request id (unique), one settlement per reservation (row lock and status),
  one hold, charge and release journal each (idempotency keys), and a call counted toward its review once.

### Tests (targeted; tsc clean)
| Suites | Result |
|---|---|
| v117 control-funded calls (new) | 7/7 |
| v116 promotional (updated) | 5/5 |
| v64 spend review, r24 experiments, v65, v68, knowledge successor, message check (unit) | all pass |
| v69, v66, v70, v71, v72, v73, v74, v100, v115 revision review | all pass |
| cognition routing, launch-checks script, phase4 privilege audit, F2 migration paths | all pass |

Updated tests where behaviour changed by design:
- v64: an unfunded review waits and uses no attempt.
- r24: Fleet Control's relevance cost is now booked; its ledger checks exclude only that overhead, and the treasury change
  equals exactly what was posted.
- Five-argument reserve: v64 and v100.
- Sonnet price: routing test and the wipe fixture.

### Fleet Control budget (proposal; not set)
- **100p rolling 24 h,** unchanged.
- **Per-call maxima,** recomputed with the corrected table (`scripts/fleet-control-bounds.ts`):

  | Review | Typical | Worst case |
  |---|---|---|
  | Message check | 3p | 6p |
  | Knowledge review | 5p | 10p |
  | Spend review | 2p | 3p |
  | Relevance | 5p + 9p | 8p + 16p |

- **New requirement under v117:** treasury unallocated money. Today it is **£0**, so Fleet Control makes no call: buyer
  messages that need a check wait, and spend reviews wait.
- **Proposal:** fund a float of at least £1.00 (one day at the ceiling) with
  `ledger-record-funding <cents> <externalRef>`, backed by real money. **£5.00 recommended.** Each day's charges move
  into the owner-reimbursable partition, so top it up by what is used. Typical use is about 0.42p per message check.

### Install, verification, rollback (procedure; script staged only after Group A gives the pins)
1. **Group A:**
   - push `fleet/funding-v116`, then build on the VPS;
   - side-install;
   - data rehearsal 115 → 117 on a throwaway copy: row counts identical, ledger verified, re-run applies nothing,
     rollback dump restores 115;
   - services rehearsal on the copy.
2. **Group B:** `fleet-release.sh` 5ee36d4 → 3c4de3d, schema 115 → 117, about 45 s controller outage. No founder unit
   restarts. Both agents stay paused; Agent-2's PID is unchanged. `FLEET_ROLLOUT_AUTO_RESTORE` stays unset.
3. **Verify (read-only):**
   - readyz 200;
   - current → 3c4de3d;
   - schema 117;
   - `fleet_ai_credit_policy.draw_order` = `promotional_first` with the rule as evidence;
   - T2 cache read 10;
   - `fleet:treasury:control_reserved` 0;
   - inference off: policy f, provider none, Fleet Control ceiling unset;
   - ledger verify true;
   - both agents paused, PIDs as before.
4. **Then entries 1 and 2:** re-run the plan script first; the recorded total must equal the Console's.
5. **Rollback:**
   - 5ee36d4 refuses schema 117, so a code-only rollback is impossible.
   - Before the entries: a restore of the verified pre-migration dump, **your explicit approval only**.
   - After the entries, or once provider data exists: freeze and fix forward.

### S1, refreshed for this build (Group D; paid; separate approval)
- **Terms:** `terms-s1-3c4de3d.json`, frozen read-only at 13:01:27Z, sha256
  `c2e664b8535ed48d65f1dda86d49934f7a4d302016e48f0a4f654ac61c387cc1`, run `scen-3c4de3d-s1`, plan C, S1 only.
- **Ceiling 360p all-in; hold 401,032,421 µ¢ ($4.01032421),** both by the release's code; identical to the 5ee36d4
  freeze apart from run id and source.
- **Re-freeze after the install:** the only expected change is T2 cache read 20 → 10. The ceiling and hold do not depend on
  tier prices.
- **Costs:** every model and reviewer call the harness controller makes is metered: founder steps, escalations and the
  agent's own reviews.
- **Fleet Control is not exercised.** The throwaway registry has no Fleet Control budget, and the correct S1 path creates
  no check. S1 therefore does not test Fleet Control.
- **The 360p is a ceiling, not a forecast.**
- **Pass:**
  - the byte check of the actual delivered PDFs;
  - every delivery reviewed, nothing owed;
  - I open both files myself.
- **Afterwards:** import once, release the hold, reconcile against the Console.

### Agent-1 launch blockers (each with evidence and its acceptance condition)
| # | Blocker | Evidence | Accepted when |
|---|---|---|---|
| L1 | Funding change not installed or reconciled | this section; production schema 115 | 3c4de3d installed (A/B), entries 1–2 applied, recorded $117.22 = Console, ledger verified, agents paused |
| L2 | Fulfilment with the repaired runtime and real Opus unproven | plan C S1 on cf86ab8 was "achieved" but graded infrastructure (candidate-cf86ab8.md:38); never run on 5ee36d4 | `scen-3c4de3d-s1` passes: byte check, my inspection of both PDFs, cost ≤ 360p imported and reconciled |
| L3 | Interruption recovery not shown on the current runtime | S2 completed on cf86ab8 only (candidate-cf86ab8.md:39). 5ee36d4 changed step handling (4,000 cap, cut-off continuation): a relevant change | S2 on the installed build passes (cap 250p). Recommended: one S1+S2 run, cap 610p, hold recomputed before approval |
| L4 | Fleet Control cannot run (unallocated £0; budget unset) | balances 26 Oct; v117 refuses unfunded calls | float funded, 100p budget set, and one real message check reserved, settled and posted during the canary |
| L5 | Spending and activation terms for Agent-1 not approved | v2.6:795-804. Fuses: 754p/day; hourly 600/h (owner 18 Oct; one record still says 20/h). Inference off | your written terms: provider/key switch, Agent-1 resume, fuse values confirmed, Fleet Control budget |
| L6 | Sales channel closed | sales closed; Agent-1 offer paused since 20 Oct; seller address re-save unconfirmed (launch-readiness B11); refund authority B7 undecided; money-out (custody) off, so refunds cannot be paid automatically | seller address confirmed, refund route decided (authority or owner-manual), offer released, sales opened by you |
| L7 | Promotional-use treatment | v69 books every agent AI charge as owed to you, including use of the free $100 | your decision: keep (no change) or record promotional use differently (a later migration) |

Already proven, not repeated:
- PayPal receiving (£1 test, 10 Oct);
- the refund leg (Agent-1 refunded £5, reconciled 21 Oct);
- the order-close rule (v108/v110 installed 20–21 Oct);
- the key and account match.

**Can wait (not blockers):**
- the 34.81p over-charge correction;
- Agent-2's b60e262 rehearsal (excluded);
- `count_tokens`;
- caching / Haiku efficiency;
- the harness keeping provider rejection reasons;
- metering Fleet Control inside S1;
- the S1 grader reading chat replies.

## Funding and activation package (prepared 24 Oct ~23Z, for approval; nothing activated, charged or posted)

B and C are complete; production runs 5ee36d4 (schema 115) unchanged since the install. Read 22:4xZ, read-only:
- both agents paused (founder cognition paused); Agent-1 PID 2004178, Agent-2 PID 866408 (b60e262, unchanged, excluded from
  activation);
- `FLEET_COGNITION_PROVIDER=none`; cognition policy disabled; Fleet Control ceiling unset;
- ledger head 1176, verify true; no open credit hold; no provider consumption since the 23 Oct containment (14:26Z).

**Two facts stated explicitly:**
- **The effective founder output cap is 4,000 tokens.** The T3 Opus tier row still says 16,000 (`fleet_cognition_tiers`,
  unchanged by design), but the installed gateway sends and reserves `founderStepMaxTokens` = min(tier max, max(4,000,
  fixed thinking budget + 1,024)). Production's thinking is adaptive (no fixed budget), so every founder step gets 4,000.
  The 7,024 case exists only for `enabled:6000`, which is not configured. Routine T1 work keeps its tier's 2,000; Fleet
  Control keeps its own caps (300 / 800 / 1,500 / 4,000).
- **Promotional API credit is separate from the Claude Code subscription allowance.** Fleet spends only the API credit of
  the Console organisation that owns its key; Claude Code's usage does not draw on it, and the subscription allowance
  cannot pay for Fleet's API calls. Fleet's spending is measured only against the Console balance.

### 1. Key organisation (not verifiable from here; owner-side, read-only)

Not done, for three reasons:
- the Console is not accessible from this machine;
- the only copy of the runtime key is the root-only recovery file, which stays untouched;
- every Anthropic endpoint that would reveal a key's organisation needs that key sent in a request.

**The check (owner):**
1. On the VPS, print only the key's last four characters (the Console displays them anyway):
   `sudo sh -c 'tr -d "\n" < /etc/automaton-fleet/recovery/cognition.key.20261023T142625Z | tail -c 4; echo'`.
2. In the Console, open the organisation whose **Billing** shows the promotional grant, then **API Keys**, and find the key
   ending in those characters. Note its workspace and last-used date (23 Oct expected).

   **Found:** confirmed. **Not found:** the key cannot spend that grant; a new key from that organisation, installed by the
   owner, is the fix.

Alternative, only on your explicit word: I run step 1 myself (one `sudo` read, four characters shown, nothing else).

### 2. Reconciliation: migration v116 (prepared, local) and the exact entries

**Fleet's side (production, read-only):**
- one owner-funded lot `05f4cb13`: $41.29 bought, **$16.76 left (1,676,179,930 µ¢)**;
- recorded balance the same; owner payable 1,081p; treasury unallocated **£0**;
- no Fleet consumption since 23 Oct 14:26Z.

**Console figures needed (not visible to me):**
- G: grant amount, date and **expiry**, with the grant's identifier;
- Rp: the promotional balance remaining;
- Rb: the purchased balance remaining;
- Uc: usage by date since 23 Oct.

**v116 (`migrations-phase116.ts`, branch `fleet/funding-v116`, local, not pushed, not built, not installed):**
- **Grant record.** `fleet_admin_ai_credit_promotional_grant` (owner, once per grant) records:
  - a lot of source `promotional`: no cash or acquisition cost, its expiry;
  - a provider-credit event `grant`;
  - the part the Console shows already used, drawn from **that grant only** (`grant_used`), never from a purchased lot and
    never attributed to an agent.
- **Expiry.** Recorded by the minutely settlement: remaining credit is drawn as `expiry`, so it stops counting for
  reservations and holds. An expired grant is never drawn.
- **Draw order.** `fleet_admin_ai_credit_draw_order` (owner, with evidence): `oldest_first` (unchanged default) or
  `promotional_first`. It is set only from what the Console shows after the first calls; it is not part of the
  reconciliation.
- **Nothing is posted.** No GBP journal, no charge, no internal agent charge. The status reports promotional credit and
  Fleet's use of it separately, with the note that its treatment is undecided. Any charge still posts as today (v69,
  owed to the owner), so the treatment decision belongs before agents work on promotional credit.
- **Wiring:** owner CLI `economy-ai-credit-promotional-grant` and `economy-ai-credit-draw-order`; privileges registered.
- **Tests:** new `fleet-v116-ai-credit-promotional-pg` **5/5**. Run with v70, v71, v72, v74, phase4 (privilege audit) and the
  v8/v24 migration paths: **6 files, 71/71, no failures.** `tsc` clean.

**Exact entries.** `scripts/fleet-ai-credit-promo-plan.sh <G> <Rp> <Rb> <grantedAt> <expiresAt> <grantRef>` reads production
read-only and prints, computed in SQL numeric, the reconciliation, any blockers and the entries in order. Checked read-only
against production with labelled sample figures (not real).
1. **Purchased first, while only purchased lots exist:** `fleet:admin economy-ai-credit-reconcile anthropic <Rb>`.
   - Difference = Rb − $16.76. Positive: usage Fleet over-recorded (or the grant was drawn first), restored to its lots.
     Negative: purchased credit used outside Fleet, drawn from the purchased lot.
   - No GBP journal (owner-funded lot). None if Rb = $16.76.
2. **The grant:** `fleet:admin economy-ai-credit-promotional-grant anthropic <grantRef> <G> <Rp> <grantedAt> <expiresAt>
   <evidence>`.
   - The lot holds Rp; G − Rp is recorded as used before recording.
   - Recorded balance afterwards = Rb + Rp, the Console total. No GBP journal.

Requires before the entries: v116 through Group A (push, build, rehearsals) and Group B (schema 115 → 116, agents paused);
your approval of each.

### 3. Fleet Control's shared daily budget (proposal; not set)

**How it works (installed code, v96/v115):**
- **One ceiling** over a rolling 24 hours (not a calendar day) is shared by all four review types: spend review, knowledge
  review, evidence relevance and message check (v115).
- **Reservation:** each call first reserves its computed maximum (prompt bytes as input tokens plus its full output
  allowance, rounded up to whole pence), under one lock. Settlement replaces the maximum with the actual cost; an unknown
  cost keeps the maximum counting.
- **Units:** the ceiling counts credit-price pence and excludes the 20 % acquisition cost of purchased credit. Promotional
  credit has no cash cost.

**Per-call maximum by code** (`scripts/fleet-control-bounds.ts`: the release's own prompt builders at their clip limits,
T2/T3 prices, FX 0.748039):

| Review | Output cap | Reserved, ASCII at limits | Reserved, worst storable text | Typical actual |
|---|---|---|---|---|
| Message check (T2) | 300 | 3p | 6p | ≈0.42p ("thanks") |
| Knowledge review (T2) | 800 | 5p | 10p | — |
| Spend review (T2) | 1,500 | 2p | 3p | — |
| Evidence relevance T2 (+ T3 escalation when uncertain) | 4,000 | 5p (+9p) | 8p (+16p) | — |

The record's earlier "worst case 3.63p" for a message check was below the true worst case (6p with 3-byte characters);
this table supersedes it.

**Proposal: 100p a rolling 24 hours** (≈ $1.34 of credit; up to 120p all-in if drawn from purchased credit).
- It covers the largest single reservation (24p, a relevance job with escalation) four times over.
- It allows at least 16 worst-case message checks in flight, or about 236 typical ones a day.
- For Agent-1 alone this is generous: production has recorded 0 spend reviews and 3 lesson proposals ever.

**When exhausted** (code, unchanged):
- No call is made and nothing is approved or decided by default.
- One `fleet_control_ai_budget_reached` event in 24 hours (Fleet Command).
- **Message checks** defer without using an attempt: the message waits and the agent's classification stays unverified.
- **Spend reviews and knowledge reviews** wait.
- **Relevance jobs** are not claimed.
- Calls in flight finish and settle.
- Nothing raises the ceiling automatically. You set, raise or clear it (`fleet_admin_fleet_control_ai_budget`, `_clear`).

**Two limits found while preparing this (not changed):**
- **Spend reviews cannot run while treasury unallocated is £0.** The spend-review claim refuses when unallocated is below
  its 3p estimate, counts that as an attempt, and stalls after 5. The spend is never approved, but a reviewed spend can
  never proceed. Setting the budget does not change this.
- **Charges go unbooked.** Knowledge and message-check charges are booked only up to the treasury's unallocated balance.
  Above it (now everything), the credit is still drawn and recorded in USD, but no GBP expense or owner payable is posted.
  Either fund unallocated by about one day's ceiling (£1.20) before setting the budget, or accept that gap. That is your
  money decision; nothing is proposed to move by itself.

**Order:** the budget is not needed for S1 (below). Set it before Agent-1 does real customer work.

### 4. S1 evaluation, frozen on the installed build (Group D; paid; separate approval)

**Terms**, from the installed release's own tools (`/opt/automaton-fleet/releases/5ee36d45…`):
- **Terms script:** `fleet-scenario-terms.sh`, sha256 `3181b58e…`, identical to commit 5ee36d4.
- **Run:** `scen-5ee36d4-s1`, plan C caps, **S1 only**. Frozen 22:37:33Z: `terms-s1-5ee36d4.json` beside this record,
  sha256 `240d4994574cdf97d18a472e9c155d75eb381f7765a644bf1bb84e96041954ef`.
- **Pricing inputs:** FX 0.748039 (23 Oct); acquisition 4955/4129 (lot 05f4cb13); production T1–T3 prices.
- **Ceiling: 360p all-in**, enforced by the cost meter before every call; a call whose worst case does not fit is never
  sent.
- **Credit hold: 401,032,421 µ¢ ($4.01).** Computed by the installed `creditHoldUsdMicro`; it is the most the run can spend.
  The recorded credit free after the hold is 1,275,147,509 µ¢.
- **Limits:** a 45-minute limit, one attempt, no rerun.
- **What the 360p covers:**
  - one worst-case Opus founder step at the 4,000 cap reserves $0.825, or **74.06p all-in**, so the ceiling holds four with
    room;
  - typical steps are 5.75p (prefix cached) to 16.70p (first step);
  - plan C's S1 spent 278.50p, before the cap and before v115.

**Exactly what runs:**
- **The founder.** A newborn synthetic founder runs runtime 5ee36d4 (Agent-1's runtime) in its own throwaway registry
  (ephemeral PostgreSQL), served by the harness's own controller.
- **The scenario:** the original paid order, then the buyer's correction (point 7: a dated line for the next check).
- **Simulated external actions:** buyer, checkout, custody, mail (shared simulated mailbox) and the PayPal rail. No real
  payment, mail or production write.
- **Costs included:** every model call the harness controller makes passes through the cost meter, one evidence row per
  call: founder steps, escalations and the agent's own reviews. The run's cost is imported once into production as
  engineering expense; no agent wallet is touched.
- **Fleet Control is not exercised.** The installed harness sets no Fleet Control budget in its registry, so any Fleet
  Control check would defer, not run. On the correct path v115 makes none: a check is created only when the agent
  classifies the buyer's message as conversation, or for a withdrawal. A misclassification would leave the correction
  undelivered, and S1 fails visibly; it is not hidden.

  Metering a Fleet Control check inside S1 would need a harness change, so a new candidate. **Not recommended now.**

**Pass**, all required:
- The grader's byte check of the **actual delivered PDFs** (`s1-correction-check`, pypdfium2) passes. Both versions keep
  ten numbered points with usable tick boxes and pass the inspector's malformed, clipping and overlap checks. The revision
  is not the first file again. The requested dated line is visible under point 7.
- Every delivery passed its own review. The correction is resolved by the second delivery, and nothing is owed at the end.
- **I open both delivered files myself** before any pass is claimed: the grader's verdict alone is not evidence.

**Procedure (after approval only):**
1. **Preconditions:**
   - the key check passed (section 1);
   - the Console balance shows at least $4.01 beyond what the run's draw order would take;
   - terms re-frozen at run time. If FX or the lot changed, the new hold is presented first.
2. **Hold:** `fleet:admin economy-engineering-credit-hold scen-5ee36d4-s1 anthropic 401032421 "<reason>"`.
3. **Run:** `sudo -n FLEET_RUNTIME_ENV_FILE=<pins> node <release>/dist/fleet/founder/cli.js scenario-suite <terms> 360
   --credit-hold 401032421 --key-file <the recovery key file> --only s1-order-and-correction`.
   - The key is read by the root harness for this run only.
   - **Production's provider stays `none`, its policy disabled, both agents paused.**
4. **After the run:**
   - inspect the files by hand;
   - `economy-engineering-calls-import` once;
   - release the hold;
   - verify the ledger and the end state;
   - report the cost by call.

**Draw order and S1:** if v116 is not installed first, the import draws the purchased lot, and the next reconciliation
corrects that. Recommended order: section 1, then the section 2 figures, then v116 through A/B, then the entries, then S1.

### 5. Agents

Both stay paused. Agent-2 (b60e262) is excluded from activation and unchanged. Nothing here resumes, upgrades or charges
either agent.

**Once funding is reconciled and S1 passes,** a real Agent-1 launch can be assessed. Installation alone does not prove
autonomous customer fulfilment.

### Approvals this package asks for (each separately)

1. **Key check:** you run the two steps, or authorise me to print the four characters.
2. **v116:** Group A (push `fleet/funding-v116`, build, side-install, rehearsals), then Group B (install, schema 115 → 116,
   agents paused). After that, the two owner entries from the plan script's output with your real Console figures.
3. **Fleet Control:**
   - the 100p rolling-24-hour ceiling, when Agent-1's real work is approved;
   - and your choice on the treasury's unallocated balance (fund about £1.20, or accept unbooked Fleet Control charges).
4. **S1 (Group D):** the frozen terms above (360p, hold 401,032,421 µ¢), using the recovery key for that run only.
5. ~~Still your decision… a later migration~~ — superseded by v118 (installed 26 Oct): promotional use is charged to no one
   and owed to no one; no internal agent charge is approved.

Not authorised by this package: any provider activation, paid call, budget change, credit posting, agent resume or
database restore.

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

## Staged canary activation package: Agent-1 (prepared 26 Oct, revision 1; PREPARATION ONLY, nothing activated)

**Production now:** 81e1ae5 at schema 119. Both agents are paused, inference is off, sales are closed, the Fleet Control
budget is unset, no credit hold exists and no canary units are installed. All figures below were read read-only or
computed by SQL on 26 Oct.

**Agent-2 stays unchanged** throughout: b60e262, paused, limits untouched. No command below names it.

### Agreed limits

| Limit | Value | Enforced by |
|---|---|---|
| Agent-1 rolling daily AI usage | 754p (unchanged; v119 counts usage from every credit source) | `fleet_cognition_authorize` (automatic) |
| Agent-1 turns | 120 per hour (currently 600) | `founder-cognition --turns-per-hour 120` (automatic) |
| Provider-credit authorisation ceiling | $15.00 = 1,500,000,000 µ¢ | ceiling hold `canary-agent1-ceiling` (automatic) plus the hourly guard |
| Fleet Control AI budget | 30p/day | `economy-fleet-control-ai-budget 30` (automatic) |
| Deadline | STARTED_AT + 7 days | `automaton-fleet-canary-end.timer`, plus the hourly check after ENDS_AT |
| Agent cash charges (guard) | 1,000p | hourly guard (monitored; the exposure stated below still applies) |

**Approval wording, kept verbatim:** $15 is an authorisation ceiling based on reserved estimates, not an unconditional
provider-billing guarantee; an underestimated call could exceed it and trigger a cost exception.

Cash exposure is unchanged from 212e76c: at most £11.23 under the credit ceiling. The hourly check alone would allow up to
£17.54.

### Inputs the owner supplies before Stage 1

**Seller address.** The stored seller identity is version 1, set 2026-10-17 18:56Z by operator:owner, legal form
individual. Its postal address reads, character for character:

```
3rd floor
45 Albemarie Street
Mayfair
London
W1S 4JL
```

The owner compares this with their own record. Note "Albemarie": the owner checks this spelling against the record,
and nothing here infers or corrects it. If it is wrong, the owner re-saves it in HQ. Before Stage 1, the stored text is
read back and quoted, and its version must be 2 if it was re-saved or 1 if confirmed as is.

**£5 treasury funding.** This is new money to the treasury PayPal (rail b71b3f3c-901c-4f22-818b-3e1b1269f420), and the
owner keeps the PayPal transaction ID. The real balance is £0.22 now. Only the actual net receipt is recorded, read from
the transaction itself (`hub-paypal-reconciliation` / the rail's transaction listing), never assumed to be 500p. If
PayPal took a fee, the receipt is below 500p and is recorded as received.


The funding posts to `fleet:treasury:unallocated` (D) against `fleet:owner:capital` (C); see `fleet_admin_record_owner_funding`.
Unallocated holds **0p** today (26 Oct, by SQL), so this is the money that funds:

- Fleet Control's reservations;
- the treasury's share of the Stage 2 refund booking.

### The offer's files: one inventory (replaces the earlier, conflicting descriptions)

Offer `d7063a0a-9aab-4d0a-800d-ee2547e89ce7`, slug `uk-landlord-compliance-tracker-england-g-a9ddde`: status paused,
files_version 5, linked review `d06474be-d05b-4fec-83e2-5428874b24d0`.

**Live deliverables, read 26 Oct:**

| File ID | Name | SHA-256 | Bytes | Action |
|---|---|---|---|---|
| `076ad190-4d4e-4bf8-b398-a464d608e9be` | Landlord_Compliance_Tracker.xlsx | `f45c3d0071f6930788ff0f8bdc29f190736c76763426322f79ca23e751cf1bd0` | 24,829 | **remove** (print clipping) |
| `c9452df2-6ff1-4140-9851-19faedeff3aa` | README.txt | `4494dff2185aeb052df9131199f34e768599e098d93b72394c994f2fe5dfcd89` | 672 | **keep** (same bytes as the candidate README) |
| `b6d299a1-a0a3-481a-9a0b-2db310fe1e45` | tracker.zip | `10adb667c1a32792e152825aabd0808cf6b0655b700c5c19f85705650d352831` | 1,801 | **remove** (see below) |

**What tracker.zip is.** It is the September CSV version, contradicting the xlsx listing. Its members are:

- README.txt, 645 B, dated 27 Sep;
- properties.csv, 593 B, dated 26 Sep;
- rent_log.csv, 241 B, dated 26 Sep.

**The stale review.** Review d06474be (18 Oct, inspector fleet-qa-2, verdict pass) covers **only** tracker.zip
(files_digest `c88786bf…`). It covers neither the xlsx nor the README. The earlier statement that "the live offer passes
fleet-qa-3" was my own inspection of the xlsx, not the offer's review.

**Final deliverables, binding:**

- `Landlord_Compliance_Tracker.xlsx` `7793dff2084dd7968019041e7579ecdedafd73529190c14b8a85a39820bc69b5` (30,462 B,
  candidate);
- `README.txt` `4494dff2185aeb052df9131199f34e768599e098d93b72394c994f2fe5dfcd89` (672 B).

Their files digest (`fleet_files_digest`) is **`f3e6193aafe44a8d5cf55809082cd7efb1aa8c9abd7c8514e4f3ceb7710d6c69`**. The
shell computation and the production function return the same value.

A fresh review passes Stage 1 only if:

- its subject is offer d7063a0a;
- its files_digest equals f3e6193a…;
- its inspector is fleet-qa-3;
- its verdict is pass;
- the offer's deliverables are exactly those two files.

Any other set, including one still containing tracker.zip, fails Stage 1.

### Telling Agent-1: the routes that exist, and why none fits

| Route | What submitting costs | Who pays the agent's answer | Verdict |
|---|---|---|---|
| Owner message (v62: HQ conversation / `fleet_admin_agent_message_send`; files reach `from-owner/`) | nothing | **the treasury**. Each pending owner message is answered in a dedicated conversation turn (`svc_cognition_conversation_authorize`, payer `treasury`). No flag routes it into an ordinary turn. | This is the paid owner conversation. It carries the known gap: a call the treasury cannot fund in full is booked only up to unallocated, with the shortfall recorded. **Excluded.** |
| Fleet Control notice (v94, `author = 'fleet_control'`) | nothing | the agent, in its ordinary working turn; it also wakes a hibernating agent | Written only by Fleet Control's own code. The runtime labels every notice "Fleet Control notice … from the Fleet's own control system" (`continuity.ts` `noticeLines`), so an owner instruction sent this way would be misattributed. **Rejected.** |
| Answer to an owner request | nothing | the agent | Agent-1 has no open request; its only one, 62cbe1b7 (Gumroad), was approved on 26 Sep. **Not applicable.** |
| Mission (`economy-mission-assign`) | nothing | the agent | Kinds are marketing, opportunity_hunt and knowledge_data only, with cost-sharing semantics. This is not product rework. **Not suitable.** |

**Limitation.** No existing route gives Agent-1 an explicit owner instruction in its ordinary, agent-paid turn.

**v120 "owner task": IMPLEMENTED LOCALLY (27 Oct candidate; not pushed, not deployed).**

- **Controller (`migrations-phase120.ts`):**
  - its own table, `fleet_owner_tasks`, rather than a message kind, so the v62 owner-conversation machinery never sees it:
    no claim, no conversation turn, no treasury payer;
  - owner-only `fleet_admin_owner_task_send` / `fleet_admin_owner_task_close` / `fleet_admin_owner_tasks`, needing an
    `operator:` actor plus the fleet_cognition approver. The agents' service role cannot call them or read the table;
  - CLI: `founder-task <agentId> "<title>" <task…>`, `founder-task-close <taskId> <reason…>`, `hub-owner-tasks [agentId]`;
  - bounded: 3 open per agent, title 3–120 and task 10–1,500 characters, no control characters, the secret detector
    applies, and dead agents are refused;
  - a task's words never change; closing happens once (immutable-history trigger);
  - Fleet Command records `owner_task_sent` / `owner_task_closed` (P3);
  - `fleet_agent_attention` gains `ownerTasks` (open tasks, oldest first) and `ownerTasksDigest`. `eventsDigest` and
    `notices` are untouched, so an agent with no task (Agent-2) sees an identical attention apart from an empty list. A
    runtime that does not know the key ignores it, so a task is never shown as a Fleet Control notice.
- **What a task does not do:** it changes no cognition setting, so a paused agent stays paused and its model calls are
  still refused. It grants nothing: spending, identity, accounts and outward release keep their own flows, and the text
  says so. It writes no owner message, conversation turn, in-flight reservation or ledger entry; the tests assert all of
  these.
- **Runtime (`continuity.ts` `ownerTaskLines` / `ownerTaskSignal`, `mind.ts`):**
  - every working packet carries each open task as "Owner task <id> (…; from your owner: an instruction for your normal
    work, paid like any step; it never approves spending, identity use, accounts or outward action …; shown until your
    owner closes it)";
  - tasks are essential lines, never shortened, and are not deduplicated, so they are visible after a restart;
  - a new or closed task changes the wake digest, so it wakes a waiting founder.
- **Cost:** Agent-1's ordinary turns, so its own wallet, its 754p/day, 120 turns/h and the $15 hold.
- **Agent-2:** keeps runtime b60e262, gets no task, and its attention digest is unchanged.

**Tests (27 Oct, local; no provider, loopback only):**

- `npx tsc --noEmit -p .`: clean.
- **New:** `fleet-v120-owner-tasks-pg` 6/6 (owner only; untouched cognition, outward, messages, turns, in-flight and
  ledger; paused stays paused; payer is the agent, not the treasury; durable until closed; bounds). Work-continuity test 11
  (first packet, every packet, after a restart, wake on a new task, gone when closed, never an owner conversation turn):
  the suite runs 32/32.
- **Related, unchanged:** launch-checks 5/5, v94 6/6, v100 obligations 20/20, v67 4/4, v119 daily-limit 5/5.
- **Two files under 4-worker load:** in the combined run, founder-upgrade failed 8/12 and migration-paths failed 1/2, all
  at the 30 s hook timeout. Run alone, unchanged, they passed: founder-upgrade 12/12 (including the real-process
  upgrade/rollback rehearsal) and migration-paths 2/2 (each step to v120; direct upgrades from v8 and v24). Both results
  are kept here.
- The four known fleet-cognition-anthropic `FLEET_INFERENCE_LOCAL_ONLY` failures were not rerun; this change does not
  touch them.

**The task text** (≤ 1,500 characters, as it would be sent):

> Adopt the corrected files for your offer "UK Landlord Compliance Tracker (England)" (offer d7063a0a, slug
> uk-landlord-compliance-tracker-england-g-a9ddde). The corrected workbook is in your workspace at
> from-owner/tracker-v6/Landlord_Compliance_Tracker.xlsx
> (sha256 7793dff2084dd7968019041e7579ecdedafd73529190c14b8a85a39820bc69b5). It fixes printing: columns were cut off on
> printed pages. 1) offer file remove: tracker.zip (the September CSV version, 10adb667…) and
> Landlord_Compliance_Tracker.xlsx (f45c3d00…). Keep README.txt (4494dff2…, unchanged). 2) offer file: attach the
> corrected workbook as a deliverable. 3) deliverable inspect both files with your acceptance cases, and look at the
> printed pages. 4) deliverable review, subject offer, of exactly those two files. If you find a defect, fix it and review
> your fixed file instead. Do not publish: sales stay closed until the owner's next step.

The agent keeps its judgement: a review of its own corrected file is acceptable, but Stage 1 then binds to that file's
digest, re-quoted. Placing the file uses the existing `from-owner/` convention, which the doctrine already tells agents
holds owner files. It is a root copy into
`/var/lib/automaton-founders/01M3F50SH7PNX2E3GST13J52AS/workspace/ws_01M3F50SH8BHKVHZP1291FN09K/from-owner/tracker-v6/`,
owner fnd-01M3F50SH7PNX2E3GST13J52AS, 0600, with hashes verified after copying.

**Not recommended, listed for completeness:** using the owner conversation with the £5 float in unallocated. Each call's
reservation is a true upper bound (v104), so the gap is narrow, but it is not closed. It needs your explicit acceptance
of the gap.

### Stage 1: safeguards, task, review; SALES STAY CLOSED

**Precondition:** v120 approved, released and installed, and Agent-1 upgraded to the labelling runtime; or another route
chosen by you.

**What it changes**, in order. Steps 1–7 run with Agent-1 paused.

1. **Funding, recorded once:**
   - `ledger-record-funding <NET> paypal:txn:<TXN_ID>`
   - `economy-paypal-attribute b71b3f3c-901c-4f22-818b-3e1b1269f420 <TXN_ID> <EVENT_CODE> owner_funding paypal:txn:<TXN_ID>`
   - Verify: one journal, unallocated = `<NET>`, owner payable still 1,081p, ledger verify ok.
2. **Limits:** `founder-cognition 01M3F50SH7PNX2E3GST13J52AS pause --turns-per-hour 120 "canary: 120 turns/h"`.
   Read back 754p and 120.
3. **Fleet Control budget:** `economy-fleet-control-ai-budget 30 "canary: Fleet Control 30p/day"`.
4. **Ceiling hold:** `economy-engineering-credit-hold canary-agent1-ceiling anthropic <balance − held − 1500000000>`.
   This was 10,023,033,480 µ¢ on 26 Oct; recompute by SQL immediately before. Verify free = 1,500,000,000.
5. **Inference reinstated** (owner and root; the key is never in chat or evidence):
   - key at `/etc/automaton-fleet/cognition.key` (0600 automaton-fleet-service);
   - `FLEET_COGNITION_API_KEY_FILE` added to service.env;
   - `cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000`, with
     prices read back;
   - `systemctl restart automaton-fleet`;
   - verify both agents paused, and Agent-2 identical to the baseline.
6. **Guard:** canary.conf, the four units, the end-timer drop-in at ENDS_AT, both dry runs writing nothing, then
   `systemctl enable --now` on both timers. Configuration as before: CANARY_ID agent1-c1, CASH_CEILING_MINOR 1000,
   CREDIT_CEILING_USD_MICRO 1500000000, HOLD_RUN canary-agent1-ceiling.
7. **Files and task:**
   - root-copy the candidate to `from-owner/tracker-v6/` and verify both hashes;
   - send `founder-task 01M3F50SH7PNX2E3GST13J52AS "Replace your tracker's files" <the text above>`.
8. **Resume:** `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "canary agent1-c1 stage 1"`. This is STARTED_AT.

**Passes when:**

- the offer's deliverables are exactly the two final files;
- a fleet-qa-3 offer review passes with files_digest f3e6193a… (or a re-quoted digest for Agent-1's own fix);
- the offer is NOT published (the task does not ask for it; sales stay closed);
- no guard stop has fired, and the ledger verifies;
- figures are reported by code;
- Agent-2 is unchanged.

The owner then closes the task (`founder-task-close`).

**Stops:**

- **Automatic** (safe stop, once): cash over 1,000p; credit consumed over $15; a ledger verification failure; a repeated
  delivery or message; ENDS_AT.
- **Refusals:** 754p, 120 turns/h, the $15 hold, the 30p Fleet Control budget.
- **Monitored:**
  - a cost exception;
  - a Fleet Control reservation open for 30 min or of unknown cost;
  - any outward posting or channel activation;
  - work outside its own offer and workspace;
  - **no passing review within 24 h of STARTED_AT**. This is a review checkpoint, not a wait for discovery: the task is
    in front of the agent from its first turn. The owner decides at the checkpoint.

**Approval S1** covers steps 1–8 as written:

- recording the funding;
- the limits;
- the Fleet Control budget;
- the hold;
- the key install, service.env edit, cognition-enable and controller restart (sudo, `/etc`, systemctl);
- the unit install and enable;
- the workspace copy;
- the task;
- Agent-1's resume.

v120 and the runtime upgrade are **separate approvals before it** (Group A/B, then the runtime upgrade).

### Stage 2: controlled order, delivery, message check, MANUAL PayPal refund (after Stage 1 passes)

**No refund authority is granted, no custody refund is sent, and REAL_PAYMENTS stays false.**

**What it changes:**

0. **Publish (approval S2):** a second owner task, "Publish on your review <reviewId>". Then close the Stage 1 task.
   Agent-1 publishes in an ordinary turn, and the offer is live only once sales open.
1. `economy-sales open`.
2. You pay £5 via `economy-offer-proof uk-landlord-compliance-tracker-england-g-a9ddde`. This is owner capital net of
   fee, never agent revenue, and is excluded from demand.
3. **Delivery:** exactly one sent delivery; its file hashes are 7793dff2… and 4494dff2…, equal to the review; no
   repeat.
4. **Message check:** you send one buyer message on the order page. Fleet Control's check reserves and settles once,
   within 30p. Agent-1 answers and classifies the message, with no repeat.
5. **Manual refund:** you refund the full £5 **in the PayPal app** on that capture.
6. `economy-sales closed`.

**How Fleet observes and reconciles the manual refund** (verified in code and on production 26 Oct, read-only):

- **Two independent sources,** counted once (the larger of the two):
  - PayPal's `PAYMENT.CAPTURE.REFUNDED` webhook. The custody worker (`paypal-treasury.ts:363`) takes the capture from
    the event and records evidence with `cx_paypal_clawback_evidence` (source `webhook`, the refund ID).
  - Transaction Search, T1107 (source `search`). The last successful search was 2026-10-26 16:21:58Z, HTTP 200.

  Neither path consults refund authority or the custody refund queue. Those govern only refunds that Fleet itself
  sends.
- **Booking** (live `cx_paypal_refund_record`, confirmed to call `fleet_order_refunded`). For an owner-proof order:
  - D `fleet:owner:capital`, C `fleet:treasury:unallocated` (owner capital returned, never the agent's);
  - a row in `fleet_offer_proof_returns`;
  - the order becomes `refunded`, so its conversation closes (v108);
  - PayPal's fee returned on the refund is recorded as fee-return evidence.
- **Precedent:** the 20 Oct proof refund came through this same evidence path: webhook evidence `841606975U696002C`, 500p
  at 21:27:48Z; Search T1107 at 00:50:36Z on 21 Oct; proof return R69207…; order 1186e00e `refunded`. That refund was
  custody-sent. A refund made in the PayPal app is new here: the code path is the same, but **its first live observation
  is this test.**
- **Condition: unallocated must cover the refund.** Since v107, a booking that unallocated cannot cover fails and is
  retried every pass. Before you refund, SQL shows unallocated ≥ 500p. That is the float's net plus the proof's net
  receipt, minus open Fleet Control reservations. If it is short, do not refund yet; report instead. The v106 claim-wait
  is not needed and is not used.
- **If it is not observed** within 24 h (webhook, plus at least one Search pass): stop. The existing owner tools then
  apply:
  - `hub-paypal-reconciliation` shows the item;
  - `economy-paypal-reconciliation-resolve` / HQ `paypal_debit_classify` classify it.

  Neither grants outbound authority.

**Passes when:**

- delivery and message check are verified;
- the refund is recorded once, with evidence from both sources (or the webhook plus a Search pass);
- the proof-return journal is 500p;
- the order is `refunded` and closed;
- the ledger verifies, and no stop fired.

**Stops:**

- Stage 1's, plus:
  - delivery hashes not equal to the review;
  - a message check that does not settle;
  - a refund not observed or booked within 24 h;
  - any posting to the agent's wallet.
- On a stop: safe stop, fix forward, no restore.

**Approval S2:**

- sales open;
- your £5 proof payment;
- your manual refund in PayPal;
- sales closed again.

**No route that differs from this** (a refund authority or a custody refund) is proposed. It would need its own
approval.

### Stage 3: as before

Sales open to ENDS_AT. Acquisition is the offer page plus your own link. There is no outward posting, no channels, no
ads, and `economy-outward` stays held. Stops are the same as above. `end` releases the hold only when no reservation is
open.

**Approval S3:** sales open for the window, and your link sharing.

### Unchanged throughout

- The four safety flags stay false, and the cap stays 2.
- Owner conversations stay excluded.
- No refund or payout authority; no custody execution.
- Agent-2 stays b60e262 and untouched.
- No production database restore.

### Cash handling: the proof payment, the manual refund and the float (read 26 Oct; figures by SQL/code)

**The precedent, as the ledger recorded it.**

PayPal transactions on the treasury rail:

| Date | Transaction | Code | Gross | Fee |
|---|---|---|---|---|
| 10 Oct | 19C47714VJ327730R | T0006 | +100 | −33 (the £1 test) |
| 19 Oct | 6JF13918S8462694B | T0006 | +500 | −45 (the proof) |
| 20 Oct | 841606975U696002C | T1107 | −500 | 0 (the refund; PayPal returned no fee) |

PayPal cash is therefore 100 − 33 + 500 − 45 − 500 = **22p**, matching the observed balance.

| Journal | Kind | Debit | Credit |
|---|---|---|---|
| 965 (19 Oct) | `owner_funding` (owner proof purchase, net of fee) | `fleet:treasury:unallocated` 455 | `fleet:owner:capital` 455 |
| 1109 (20 Oct) | `owner_proof_return` | `fleet:owner:capital` 500 | `fleet:treasury:unallocated` 498 + `fleet:treasury:owner_reimbursable` 2 |

- **The sale.** It is not a sale in the books. The owner paid their own agent's offer with their own money. Booking that
  as agent revenue would fabricate demand and give the agent cash nobody earned, so the money is the owner's contribution
  to the treasury: owner capital. Only what PayPal actually delivered is credited, net of PayPal's fee (455p). The agent's
  wallet, revenue and sweep figures are untouched.
- **Funding the refund.** The refund returns that contribution, gross: the owner gets 500p back, so owner capital is
  debited 500p. It is paid from `fleet:treasury:unallocated`. On 20 Oct unallocated held 498p, so v107 took the missing 2p
  from `owner_reimbursable`, the cash set aside for the owner, without changing what is owed.
- **The fee.** PayPal kept the 45p fee on the purchase and returned none on the refund. The owner's net capital from the
  round trip is +455 − 500 = **−45p**. The fee is borne by owner capital: real cash and owner equity both fell 45p. It
  balances, but it is **not shown as a fee line**; it is implicit in the capital movements. That is a presentation gap,
  not a balance error. A separate fee expense line would be a change of accounting policy, so it is noted and not changed.
- **For the canary.** The refund needs 500p in unallocated when PayPal reports it. That comes from:
  - the float's net (`<NET>`);
  - the proof's net (≈455p, if PayPal's fee is the same 45p);
  - minus open Fleet Control reservations.

  The float still available afterwards = `<NET>` − the proof fee PayPal keeps − Fleet Control charges. By code, with no
  Fleet Control charges: a 500p float leaves **455p**, and a 455p float leaves **410p**. Each Fleet Control check, up to
  30p a day, reduces it further. The float is **partly consumed** by the test: by the proof's fee and Fleet Control's
  checks, never by the refund itself.

**1,079p owner-reimbursable vs 22p in PayPal vs 1,081p owner payable.** These are three different things:

- **`fleet:owner:payable` 1,081p** is what Fleet owes the owner. It is the AI usage the owner's provider credit paid for
  after the v74 write-off, plus acquisition tax/fees. It is a liability, not cash.
- **`fleet:treasury:owner_reimbursable` 1,079p** is the book cash set aside to repay that liability (v69). Each posting
  that created payable also moved book cash into this partition. By journal kind, computed by SQL:
  - opening, 12 Oct: +1,824 (created against payable, with no cash source);
  - agent inference charges: +880 (239 postings, from the agents' wallet cash);
  - AI-credit acquisition tax/fees: +543 (59 postings, from wallet cash);
  - owner-conversation turns: +20 (5 postings, from unallocated);
  - a search job: +1;
  - the v74 write-off: −2,187 (moved to unallocated as the owner's contributed capital);
  - the 20 Oct refund: −2.

  1,824 + 880 + 543 + 20 + 1 − 2,187 − 2 = 1,079.
- **The 2p difference** (1,081 − 1,079) is the 20 Oct refund's v107 draw.
- **Why it is not in PayPal.** Fleet's book cash is 20,022p: the agent wallets 8,943 + 10,000, plus reimbursable 1,079.
  `fleet_capital_backing` reports 20,000p of that as **unbacked virtual capital**: the two £100 genesis allocations,
  never paid in. 20,022 − 20,000 = 22p, exactly PayPal's balance (difference 0). The money that moved into
  `owner_reimbursable` came out of virtual wallet money, so it is itself unbacked. The payable is real: the owner did pay
  the provider. The cash the books set aside to repay it has not been funded.
- **So:** the owner is owed 1,081p; Fleet has 22p of real cash; none is reimbursed; nothing here is lost or
  double-counted. Repaying the owner needs real money in, which is a separate decision.

**Before the £5 transfer:**

- **Destination:** the treasury PayPal on rail b71b3f3c-901c-4f22-818b-3e1b1269f420. Its stored account reference is
  `F*************@proton.me`, consistent with fleet.treasury@proton.me. Confirm in your PayPal that you are sending to
  that account.
- **Fees:** PayPal charged this account 33p on £1 and 45p on £5 for payments received as purchases. Whether a transfer
  from your own PayPal is charged depends on how it is sent, so I won't assume it. Fleet records exactly the net the
  transaction shows, read back from Transaction Search.

## Funding position before Group A (27 Oct; read-only; every figure by SQL or code)

### 1. Agent-1, separated

| What | Figure | What it is |
|---|---|---|
| Book wallet (`agent:…AS:cash`) | **8,943p** | 10,000 genesis allocation − 2,239 inference − 447 AI-credit tax/fees − 1 media + 1,630 restored by the v74 write-off |
| Real cash behind it | **0p** | The allocation was `owner-authorized-virtual:genesis-founder`: owner capital recorded with no money paid in. No backing is recorded (`fleet_capital_backing`: backed 0, unbacked 20,000 for both agents). The treasury PayPal holds 22p in total, all of it the residue of the £1 and £5 tests. |
| Liabilities from its activity | **1,057p** owed to the owner | Part of `fleet:owner:payable` 1,081p accrued since the write-off: Agent-1 inference 880 + tax/fees 176 + media 1; the other 24p is the fleet's own. The owner's provider credit paid these; nothing is reimbursed. |
| Customer obligations | **0** | No paid ordinary order, open or otherwise. |
| Inference capacity | **$98.0103348 promotional** (expires 24 Nov, assumed 00:00Z cutoff) **+ $17.22 purchased** (owner-paid) | Fleet-wide provider credit, not PayPal cash. For the canary Agent-1 is bounded by the $15 hold, 754p/day and 120 turns/h. |

**What the book wallet can and cannot do today.** It pays Agent-1's internal AI charges. Those move book money into the
owner-reimbursable partition, and the provider is paid by credit, so no PayPal money moves. It cannot move real money:
custody execution, money-out, card authority and refund authority are all off. The balance therefore shows neither
runway nor an ability to cover refunds or other cash obligations. It is a budget figure on virtual capital.

### 2. Smallest explicit launch treatment: proposed, nothing posted or changed

**Recommended: (A) disclose and bound.** Nothing is written off, funded or reclassified; the existing records already
state it (`fleet_capital_backing`: virtual 20,000, unbacked 20,000). The launch record and the Stage 1 approval carry this
statement:

> "Agent wallets are unbacked starting allocations (2 × £100 virtual owner capital). During the canary no wallet money
> can leave PayPal. Real cash obligations (PayPal fees, the fee residue of any refund) are met only from real treasury cash
> (the £5 float). Before any manual refund, real PayPal cash is checked by SQL against the refund's residue. A shortfall
> stops the canary rather than drawing on virtual money."

This adds no code; the check before a refund becomes a monitored stop.

**Not recommended for this canary:**

- **(B) back the allocation with real money** (`economy-capital-back`, v66). The backing posts no new capital, so
  unallocated stays 0. It would therefore not fund Fleet Control or the refund booking; a float would still be needed.
- **(C) write down the allocations.** That is an accounting-policy change, which you excluded.

**The £5 stays ordinary owner funding** (`ledger-record-funding`), not a backing. A backing would leave
`fleet:treasury:unallocated` at 0, where Fleet Control reserves and refunds are booked from.

### 3. Real money the bounded canary needs

| Item | Real PayPal money | Bound |
|---|---|---|
| API usage (agent and Fleet Control) | **£0 from PayPal** | Provider credit, promotional first ($98.01 > the $15 ceiling). If purchased credit is drawn, the owner already paid for it, and it becomes payable to the owner. |
| Fleet Control's reserve | **£0 leaves PayPal** | Up to 30p is held in `fleet:treasury:unallocated` and released at settlement. It is consumed only for the purchased-credit part (v117/v118), at most 30p/day = 210p over 7 days, and expected 0 while promotional credit lasts. It is consumed in the books only (moved to owner-reimbursable). |
| PayPal fee on your proof payment | **45p**, kept by PayPal | Observed on 19 Oct; none returned on the refund. |
| Your proof refund | **500p** out, 455p of it the proof's own net receipt | Net cost = the fee above. |
| Each refunded ordinary sale | **≈45p** per £5 sale (the fee PayPal keeps) | The rest is the sale's own money. Exposure = 45p × refunded sales. |

By code:

| Float | After the proof | After the worst-case Fleet Control figure | Refund residues still covered |
|---|---|---|---|
| 500p | 455p | 245p | 5 |
| 455p | 410p | 200p | 4 |

Not covered by the float: a PayPal dispute or chargeback fee, if one were charged. It would be a monitored stop.

### 4. Owner-capital treatment is only for the identified proof order

- `owner_proof` defaults to false (v76). It is set only by `fleet_admin_offer_proof`, the owner-only
  `economy-offer-proof` command that creates that one order.
- The capture and refund recorders take the owner-capital branch only `IF EXISTS (… z.owner_proof)` for that checkout.
- Every other order follows the ordinary paths: the capture becomes agent revenue (net of fee), and a refund or reversal
  is reconciled from PayPal evidence against the agent (v57 clawback) and closes the order.
- Production has 0 ordinary paid orders for Agent-1 today. Stage 2's proof order is the only owner-capital case.

### 5. Group A vs activation

The funding position affects **activation only**. Group A runs on a throwaway copy, a synthetic founder and a fake
provider: no funding, wallet, sale or refund is involved, and production is compared before and after. The decision on
the starting allocations belongs to the Stage 1 approval.

### Group A scope for code commit `7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2` (for approval; not run)

Changes after 81e1ae5:

- v120 owner tasks (migration, CLI, admin);
- the runtime's owner-task lines and wake signal;
- tests and documentation.

**Steps:**

1. **Push** `fleet/canary-prep` to fleet-origin, no force: 3c30502, 5be54ff, 7c194b8 and this documentation commit. The
   remote head is 212e76c now.
2. **Build on the VPS** with `fleet-deploy-release.sh build`, two passes. Pins come from pass 1's output into
   `~/rlc137/pins.txt` and are never placeholders. Pass 2 verifies them.
3. **Side-install** to `/opt/automaton-fleet/releases/7c194b8…`. `current` stays 81e1ae5.
4. **Data rehearsal:** `fleet-rollout.sh rehearse ~/rlc137/pins.txt 119 120`.
5. **Services rehearsal:** `fleet-upgrade-rehearsal.sh ~/rlc137/pins.txt 119 120`. 81e1ae5 must refuse schema 120, and
   rollback is a database restore of the copy.
6. **New: founder-runtime rehearsals** (sudo, throwaway registry, fake provider, synthetic founder):
   - `fleet-founders.sh upgrade-rehearsal 5ee36d4`: Agent-1's current runtime to 7c194b8, then upgrade, rollback and
     re-upgrade;
   - `fleet-founders.sh revision-rehearsal`: the runtime changed, so it is rerun;
   - living founders untouched.
7. **New: v120 check on a disposable copy** (copy-check, then dropped):
   - send a task to the copy's Agent-1;
   - its attention shows it, and Agent-2's attention and digest are unchanged;
   - no conversation turn, in-flight reservation or journal;
   - close it.
8. **Production before and after:** identical. That covers schema 119, the ledger head, both agents paused on the same
   PIDs, settings, and no tasks.

UI 0.26.2 is reused. Agent-2 is not involved.

**Not in Group A:**

- install (Group B);
- Agent-1 `upgrade-preflight` / `upgrade-runtime` (Group C);
- any task, funding, hold, timer or paid call.

## Group A on 7c194b8 (26 Oct, 17:43–18:15Z): PASSED; production unchanged

Approved by the owner for code commit `7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2`.

- **Docs head pushed:** `8e301202b5e52c2f835a5e4b7893bb8357410b0a`. `git diff --name-only 7c194b8 8e30120` lists only this
  record, so the changes after the code commit are documentation only.
- **Models:** every model in Group A was fake: the scripted model behind a loopback fake Messages API with a fake key.
  No paid call was made; costs in the rehearsal logs are synthetic.

| Step | Result |
|---|---|
| 1. Push | `fleet/canary-prep` to fleet-origin, fast-forward `212e76c..8e30120`, no force |
| 2. Build (VPS) | Pass 1 read the identity; pins written from its output to `~/rlc137/pins.txt`. Pass 2 verified **build `1100ee336a61bb450417a1a912389505c410330341b9a1fcbf7ef2f727976901`**, lockfile `1df54e35…` (unchanged) |
| 3. Side-install (sudo) | `/opt/automaton-fleet/releases/7c194b8…`, identity re-verified; `current` stayed 81e1ae5 |
| 4. Data rehearsal `fleet-rollout.sh rehearse 119 → 120` | **PASSED 17:46:24Z.** Row counts identical; only 120 applies; privilege audit `ok`, no problems; 1,117 journals; ledger verify true; rerun no-op; the rollback dump restores 119 with the same head |
| 5. Services rehearsal `fleet-upgrade-rehearsal.sh 119 → 120` | **PASSED 17:47:17Z.** 81e1ae5 refuses 120 (rollback = database restore); the candidate controller, Operator API and dashboard were ready on 120; ledger unchanged; rollback restored 119, and 81e1ae5 was ready again; production PIDs unchanged |
| 6a. Founder upgrade rehearsal (sudo) `upgrade-rehearsal 5ee36d4…` → 7c194b8 | **PASSED 27/27.** A synthetic founder on Agent-1's runtime was upgraded, rolled back and re-upgraded, with routed cognition through fake provider paths. Production unchanged, host clean, living founders untouched (PIDs 2004178 / 866408) |
| 6b. Revision rehearsal (sudo) | **PASSED 19/19.** Production unchanged, host clean, living founders untouched |
| 7. v120 on a disposable copy (`copy-check.sh` sha `fc064939…`; dropped) | See the list below |
| 8. Production before / after (17:43:06Z / 18:14:54Z) | See the list below |

**Step 7 results:**

- schema 120, privilege audit ok;
- a task sent with `operator:ubuntu` appears in Agent-1's attention (id matches);
- a non-owner actor is refused with `FLEET_APPROVAL_REQUIRED`;
- Agent-2's attention is byte-identical;
- Agent-1's `eventsDigest` is unchanged (tasks have their own digest);
- cognition settings, conversation turns (2), in-flight (0), journals (1,117), messages (6) and ledger verify are
  unchanged;
- `hub-owner-tasks` lists it;
- after the close, the task list is empty and the digest is the empty md5; a second close is a replay;
- events: one sent, one closed;
- the live ledger head and schema are unchanged, and the live table is absent.

The script printed "NOT-REFUSED" beside the refusal. That line is an artefact of `pipefail` in the check's `|| echo`
fallback, not a failure: the refusal code was matched, and the copy held exactly one task afterwards.

**Step 8 results:**

- identical: schema 119; ledger head 1176 `e214852e…`, verify true; agents (Agent-1 5ee36d4, Agent-2 b60e262, both paused,
  PIDs 2004178 / 866408); state; units; unit files; packages; tools; settings (sha `28dba03d…`, equal to 81e1ae5's
  post-install capture);
- **events:** 3,410 → 3,376. The live controller's retention pass removed 40 expired temporary rows (13 session_opened,
  1 runtime_approved, 2 each of 13 role-grant kinds). Six new rows are the paused agents' routine `session_opened`
  renewals (ids 11040–11045). Permanent history is unchanged: 340 rows, the same digest.

**Not done:** install, runtime upgrade, any production task, funding entry, credit hold, timer, inference, cutover or
restore.

## Owner corrections and decisions (26 Oct)

**Proposed vs current settings.** The canary limits are **proposed**, not active. Production now, read at 17:43Z:

| Setting | Current production | Proposed for the canary |
|---|---|---|
| Agent-1 daily AI limit | 754p | 754p |
| Agent-1 turns per hour | **600** | 120 |
| Provider-credit ceiling | **none** (no hold) | $15.00 hold (`canary-agent1-ceiling`) |
| Fleet Control AI budget | **unset** | 30p/day |
| Deadline / guard timers | **none installed** | STARTED_AT + 7 days, check hourly |
| Agent-2 | paused, 3,000p/day, 60 turns/h, b60e262 | unchanged |

**Refund-capacity figures are estimates.** The figures under "Real money the bounded canary needs" assume PayPal's fee
stays 45p per £5 and that refunded sales' own proceeds are retained in PayPal. Actual fees and retained proceeds are read
from the transactions and decide the real figure.

**Commercial selection (owner, 26 Oct).**

- The tracker is an **execution-test product**, not an approved commercial strategy.
- Reusable technical procedures are kept: delivery, review, the refund paths.
- Simulated orders, the owner proof purchase and successful file generation are **not evidence of market demand**.
- **Before public acquisition (Stage 3),** Agent-1 must propose an evidence-backed offer, comparing:
  - customer demand;
  - achievable value;
  - demonstrated capability;
  - acquisition access;
  - full delivery and support costs.

  It considers tailored services alongside digital products, and may recommend replacing the tracker. No example is
  pre-selected.
- No research spend or external posting is authorised by this.
- The technical scope (Group A, B and C, Stages 1–2) is unchanged. **Stage 3 now waits for that proposal and your
  approval of it.**

## Group B / C package for 7c194b8 (prepared; NOT run; needs approval)

**Group B: install release 81e1ae5 → 7c194b8, schema 119 → 120.**

- **Script:** `install-7c194b8.sh` beside this record, sha256
  `0e00fc5b6827426be8dbe8a70a126dd1e8df8067dc6852d06ed60f9a85ea17c9`, staged identically as `~/rlc137/install.sh`.
  It is generated from the 81e1ae5 script with only these changes: the pins, schema 119 → 120, and the v120 checks.
- **Run:** `bash ~/rlc137/install.sh`.
- **Pins:** commit `7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2`, build
  `1100ee336a61bb450417a1a912389505c410330341b9a1fcbf7ef2f727976901`, lockfile
  `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1`. UI 0.26.2 is reused (sha `77ce19a4…`).
- **Gates, all checked before any change:**
  - the pins;
  - both rehearsals of 7c194b8 passed and are under 24 h old (run again after 17:46Z on 27 Oct);
  - UI checksum;
  - release directory present;
  - both agents paused on 5ee36d4 / b60e262;
  - inference off (policy disabled, provider none, Fleet Control unset);
  - permissions closed (outward release, card, custody, sales, refund authority);
  - the four flags false;
  - schema 119 on 81e1ae5;
  - no open credit hold;
  - no canary unit;
  - founder unit template identical;
  - `FLEET_ROLLOUT_AUTO_RESTORE` unset;
  - a fresh full-dump baseline (TOC checked), kept and never restored by the script.
- **Change:** `fleet-release.sh` cutover. It takes a fresh dump, migrates 120, reconciles, approves the runtime and
  restarts the controller-side units. **No founder unit restarts**, and no task is sent.
- **Verification:**
  - controller ready;
  - both agents paused with the **same PIDs and runtimes**;
  - inference off;
  - tiers, ledger head, credit and owner payable unchanged;
  - v116–v119 checks still hold;
  - **v120:** zero owner tasks, an empty `ownerTasks` list and the empty digest for both agents, no owner-task event;
  - unit files unchanged, flags false, permissions closed, ledger verified;
  - settings captured.
- **On failure:** no database restore. Controller-side units stop and you decide; the pre-install backup is kept.

**Group C: Agent-1's runtime 5ee36d4 → 7c194b8, while paused (after Group B; separate approval).**

1. `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS`. This
   changes nothing.
2. `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS`. Agent-1's
   unit restarts on 7c194b8 and **stays paused**; the `upgradeId` is recorded.
3. Verify:
   - Agent-1's runtime is 7c194b8 and paused;
   - its heartbeat and health challenge pass;
   - its identity, memory, workspace and ledger accounts are unchanged;
   - **Agent-2 is untouched:** b60e262, PID 866408, paused;
   - inference off;
   - ledger head unchanged.

**Rollback:** `fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS <upgradeId> <reason>`, back to 5ee36d4. It
was rehearsed in step 6a.

**Not in B or C:**

- sending a task;
- funding;
- a credit hold;
- timers;
- the key, inference or the Fleet Control budget;
- resuming either agent;
- opening sales;
- any paid call.

These are Stage 1, with its own approval.

## Groups B and C INSTALLED (26 Oct, 18:52–18:55Z): production on 7c194b8, schema 120; Agent-1 upgraded while paused

Approved by the owner for commit `7c194b8c2348baa8fa5d34bd7ef6b201dc4911c2`, build
`1100ee336a61bb450417a1a912389505c410330341b9a1fcbf7ef2f727976901`. Group C ran only after Group B had verified.

**Group B** (`~/rlc137/install.sh`, sha256 `0e00fc5b…17c9` verified before the run; `FLEET_ROLLOUT_AUTO_RESTORE` unset):

- **Gates:** all passed.
- **Pre-install backup:** `~/rlc137/baseline-pre-install-7c194b8-20261026T185215Z`, 5,457 dump entries; kept, not
  restored. Its summary line prints "toc 0 lines", a quirk of that line; the gate's own count read 5,457.
- **Release 81e1ae5 → 7c194b8, schema 119 → 120:**
  - **outage 18:53:16–18:54:02Z (46 s)**;
  - reconciliation OK;
  - `RELEASE 7c194b8 DEPLOYED 18:54:10Z`, readyz 200;
  - root UI 0.26.2 reused.
- **Verified:**
  - both agents paused with the same PIDs at that point;
  - inference off;
  - tiers, ledger head, credit and owner payable unchanged;
  - zero owner tasks, empty task lists and digests;
  - unit files unchanged, flags false, permissions closed, ledger verified.

**Group C** (Agent-1 only):

- `upgrade-preflight`: ok (5ee36d4 → 7c194b8, 1,087 state files).
- `upgrade-runtime`: **verified**.
  - **upgradeId `cc7e1df3-b150-4f68-9879-6ed84cd5a4aa`**;
  - downtime 2.6 s; PID 2004178 → **2135441**;
  - one health challenge passed after 1.4 s;
  - identity, credential, memory, mind and workspace byte-identical (state sha `258c26ba…`, 1,087 files, nothing lost,
    changed or added);
  - Agent-1's ledger accounts unchanged (cash 8,943, expense 1,057; 941 journals, last seq 1176);
  - backup `/var/lib/automaton-fleet-upgrades/cc7e1df3-b150-4f68-9879-6ed84cd5a4aa`.
- **Rollback, exact:**
  `sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS cc7e1df3-b150-4f68-9879-6ed84cd5a4aa "<reason>"`
  (back to 5ee36d4; rehearsed in Group A step 6a).
- **Agent-2:** b60e262, PID 866408, paused; untouched before, during and after.

**Final state (18:55Z, read-only):**

- **Release:** `current` = releases/7c194b8. runtime.env pins 7c194b8 / `1100ee33…6901`; fleet_state runtime 7c194b8,
  cap 2, DEVELOPMENT, 2 living.
- **Schema:** 120.
- **Agents:**
  - Agent-1 7c194b8, paused, 754p/day, 600 turns/h, PID 2135441;
  - Agent-2 b60e262, paused, 3,000p/day, 60 turns/h, PID 866408.
- **Ledger:** head 1176 `e214852e…`, verify true. Owner payable 1,081p.
- **Credit:** balance 11,523,033,480 µ¢, held 0, open holds 0.
- **Off and closed:**
  - inference off (policy disabled, `FLEET_COGNITION_PROVIDER=none`, no key-file line);
  - Fleet Control budget unset;
  - sales closed;
  - no outward release, refund authority, custody activation or identity/card autonomy;
  - no canary units;
  - owner tasks 0;
  - the four flags false.

## Stage 1: ready for its approval (preconditions now met)

- v120 is installed, and Agent-1 runs the runtime that shows owner tasks.
- The Stage 1 steps, task text, stops and approval list are as recorded above under "Stage 1: safeguards, task,
  review".
- **The hold, recomputed by SQL just now:** 11,523,033,480 − 0 − 1,500,000,000 = **10,023,033,480 µ¢**. It is
  recomputed again immediately before placing it.
- **Still owed by you before Stage 1:**
  - the seller-address check ("Albemarie");
  - the £5 treasury deposit and its transaction ID.
- **Scope:** the tracker remains an execution test (Stages 1–2). Stage 3 waits for Agent-1's evidence-backed offer
  proposal. No repeat of the completed paid S1+S2 tests is planned.

## Treasury display and sealed-information fix (26–27 Oct; LOCAL ONLY; nothing deployed, posted or funded)

Owner, 26 Oct:

> "the treasury shows 10.79gbp when the paypal has 0.22p only … it didnt take into account the 5gbp refund by the looks of
> it … when any information is stored and sealed, it should show the information sealed and not request it to be inputted
> again".

Activation preparation is paused. Both agents remain paused, and Agent-2 is unchanged. Production was only read.

### 1. The funding and refund trace (PayPal evidence and Fleet journals; production, read-only)

**PayPal transactions on the treasury rail** (`b71b3f3c…`) — the only three that exist:

| Date (UTC) | Transaction | Code | Gross | PayPal fee | Net to PayPal | What it was |
|---|---|---|---:|---:|---:|---|
| 10 Oct 19:58 | `19C47714VJ327730R` | T0006 | +100 | −33 | +67 | **Your £1 receiving test** (checkout `e5bd5e23…`, purpose `owner_test`) — the earlier funding |
| 19 Oct 18:38 | `6JF13918S8462694B` | T0006 | +500 | −45 | +455 | Your £5 proof purchase of Agent-1's tracker (checkout `ce819ec1…`, order `1186e00e…`, `owner_proof`) |
| 20 Oct 21:16 | `841606975U696002C` | T1107 | −500 | 0 | −500 | The full refund of that proof order (refund `R69207…`); PayPal returned no fee |

PayPal now: 67 + 455 − 500 = **22p**. This matches the GBP balance PayPal reports (observed 26 Oct 18:53Z).

**Fleet journals for real money:**

| Seq | Kind | Reference | Debit | Credit |
|---|---|---|---|---|
| 842 | `owner_funding` | `paypal:capture:19C47714VJ327730R` | `fleet:treasury:unallocated` 67 | `fleet:owner:capital` 67 |
| 965 | `owner_funding` | `paypal:capture:6JF13918S8462694B` | `fleet:treasury:unallocated` 455 | `fleet:owner:capital` 455 |
| 1109 | `owner_proof_return` | `paypal:proof:refund:R69207cfe…` | `fleet:owner:capital` 500 | `fleet:treasury:unallocated` 498 + `fleet:treasury:owner_reimbursable` 2 |

**The refund was recorded exactly once.**

- One T1107 transaction and one journal (1109).
- One `fleet_offer_proof_returns` row.
- The order is `refunded`.
- The evidence arrived by webhook (20 Oct 21:27:48Z) and by Transaction Search (21 Oct 00:50:36Z). It counts once (the
  larger of the two), as designed.
- **The fee:** PayPal kept the 45p fee on the purchase. It is reflected in the books as the gap between 455 credited and
  500 returned: your capital, net, fell 45p.

**Where the £1 test's 67p went.** In the books, `unallocated` is one pool:

| Movement | Amount | Source |
|---|---:|---|
| In: £1 test, net | +67 | |
| In: v74 write-off, net of the wallets it restored | +1 | +2,187 − 2,186 |
| Out: a knowledge review | −1 | 12 Oct |
| Out: five owner-conversation turns | −20 | 18 Oct; moved to money set aside for you |
| Out: AI-credit tax/fees | −4 | 18 Oct; set aside for you |
| Out: the proof refund beyond the proof's own net receipt | −43 | 498 − 455 |
| **Unallocated now** | **0** | |

The other 2p of the refund came from the money set aside for you (v107). Of the real 67p, 45p paid PayPal's proof fee, and
22p remains in PayPal. In the books that 22p sits inside the set-aside-for-you partition.

Every movement of `unallocated` since the start, by journal kind:

| Journal kind | Movement |
|---|---:|
| owner funding (4 journals) | +20,522 |
| genesis allocations | −20,000 |
| knowledge review | −1 |
| write-off | +2,187 / −2,186 |
| owner conversations | −20 |
| acquisition cost | −4 |
| proof return | −498 |
| **Total** | **0** |

**Current position (production, read-only, 26 Oct ~19:25Z):**

| | |
|---|---:|
| PayPal cash (actual, GBP) | **£0.22** |
| Books cash (treasury + wallets) | £200.22 |
| Unbacked starting capital (2 × £100 virtual genesis) | £200.00 |
| Reconciliation: £200.22 − £200.00 − £0.22 | **£0.00 → reconciled** |
| Available treasury (unallocated money that real cash covers) | **£0.00** |
| Fleet Control reserved | £0.00 |
| Owed to you (owner payable: Agent-1 £10.57 + Fleet £0.24) | **£10.81** |
| Set aside in the books to repay it (`owner_reimbursable`) | **£10.79** (the 2p gap is the 20 Oct refund draw) |
| Agent wallets (book budgets: Agent-1 £89.43, Agent-2 £100.00) | £189.43, of which backed by real money at most **£0.00** |
| API credit (Anthropic; USD; not cash) | $115.23 (promotional $98.01, purchased $17.22, held $0) |

**Funding needed: none for Stage 1.** Agent-1's AI usage draws provider credit, not PayPal cash. A Stage 1 Fleet Control
call (a spend review, for example), if any, would be refused while unallocated is 0; it would not be paid out of other
money.

**Stage 2** needs real money in `unallocated`:

- Fleet Control's message check reserves up to 30p.
- The proof refund booking needs 500p, against the proof's own net receipt of about 455p.
- So about **75p of net real money is the minimum** for one controlled order. The earlier £5 figure was a round working
  reserve.
- The 22p already in PayPal is earmarked in the books for repaying you. Using it would mean moving book money out of
  the set-aside-for-you partition, which is an adjustment for separate approval. None is proposed.

### 2. Root causes and what changed (candidate HQ 0.27.0 + schema v121, read-only)

| HQ showed | Was | Root cause | Now |
|---|---|---|---|
| Overview "Treasury" £10.79; Treasury page headline £10.79; "Treasury cash" / "Spendable Treasury cash" £10.79 | `fleet_treasury_cash()` | The sum of every `treasury_cash` ledger partition: all of it was money set aside to repay you, labelled "real spendable Treasury funds" | **Available treasury (backed)**: unallocated money real cash covers, only while the books reconcile (else "unknown — …", never 0). **PayPal cash (actual)** beside it |
| "Real money held" £200.22 | `fleet_treasury_health.cashMinor` | Book cash of the treasury and wallets, including £200 of unbacked starting capital | Relabelled **"Book cash (ledger, includes unbacked capital)"**; the new Treasury position panel shows the reconciliation |
| PayPal £0.00 | Newest balance row of **any** currency | Each sync writes GBP then USD 2 ms later, so the USD row (0) was shown | `fleet_paypal_balance_latest()`: the accounting currency's (GBP) newest balance, used by Treasury health and Money states |
| Agents' wallets £189.43 / "Available — agents" | Book budgets | No unbacked marking | "Agents' wallets (book budgets)"; the position shows "backed by real money: at most £0.00" |
| Money & identity → Address: with nothing stored, an empty form under "Each is sealed…" | Correct state, misleading words | **No residential address had ever been stored before 26 Oct 19:09:51Z** (`owner_identity_uploaded` / `installed` at 19:09:51 / 19:09:58). The section's description read like a status | Four explicit states: **saved and sealed** (with **Show the saved address (passkey)**: the existing Reveal, 60 s, logged, never stored) / **not saved yet** + form / **reading…** / **could not read** (no form while unknown) |
| Address / bank details form | `JSON.stringify(v)` is never empty | A blank or incomplete submit would have **replaced** the sealed value | Refused before anything is sealed (`addressProblem`, `bankProblem`, `factProblem`) |

The **seller postal address** (Business details) is a separate, plaintext public record. It was already shown read-only,
version 1, and you have confirmed it accurate: that prerequisite is complete.

**New read (schema v121):** `fleet_treasury_position()`, through the dashboard read op `treasury_position`. It returns:

- actual GBP cash, with its observation time and freshness (stale after 26 h);
- the reconciliation, with status reconciled / unresolved / unavailable;
- the available backed figure;
- the treasury partitions;
- wallets with their backed share;
- owner payable and set-aside;
- API credit in USD, kept apart.

It posts nothing.

**Legacy figure, unchanged and still in use (disclosed, not corrected):**

- `fleet_treasury_cash()` and the wealth field `treasuryCashMinor` still mean "the sum of `treasury_cash` ledger
  partitions" (today £10.79, all of it set aside for you).
- They are still read by `fleet_replication_health` (the replication gate compares it with approved obligations) and by
  `svc_notify_tick` (the insolvency notice).
- Neither consumer is corrected by this change. Correcting them is an economic-policy change for separate review.
- Replication is off, and the cap is 2.

### 3. Tests (local; no provider, no paid call)

- `npx tsc --noEmit` clean for the repository and for `codex-dashboard`. ESLint is clean on the eight changed HQ files.
- **New:**
  - `fleet-v121-treasury-position-pg` 5/5:
    - GBP balance beats a later USD row in all three reads;
    - no double count;
    - API credit kept out of GBP;
    - unresolved / stale / no balance → no available figure;
    - reconciled → available = unallocated covered by cash;
    - the replication figure is unchanged;
    - reads post no journal;
    - the gateway op exists;
    - privilege audit clean.
  - `fleet-codex-vault-treasury-view` 3/3: the four states, blank and incomplete values refused, available text.
- **Existing, rerun:** HQ live contract 13/13, PayPal treasury 10/10, completion v51 14/14, notification detail 8/8.
  The migration chain applies to v121 with a clean audit (the v120 suite's migration case).
- **UI evidence** (`hq-0.27.0-evidence/`, production figures only, amounts with no secrets):
  - `before.png` (sha `06a52a3b…`): the old labels and values;
  - `after.png` (sha `e025ae20…`): the real `TreasuryPosition` and `SavedOr` components, server-rendered with HQ's CSS and
    inspected;
  - renderer `render-evidence.tsx`.
  - The Overview card and Treasury headline changes in `page.tsx` were made after that render. They are covered by the
    typecheck and the helper tests, not by a screenshot.

### 4. Remaining, and deployment scope (needs approval; nothing run)

**Remaining:**

- A live check in HQ after deployment: the Treasury position panel; your vault address shown via Show (passkey).
- Stage 2's reserve funding decision (about 75p minimum net, or the £5 working reserve).
- The legacy consumers above, for separate review.

**Deployment, when approved:**

- **Group A:** push, two-pass build, side-install, data and services rehearsals 120 → 121, UI 0.27.0 built and its
  checksum recorded, production before and after.
- **Group B:** `fleet-release.sh` 120 → 121 with UI 0.27.0. No agent runtime change: these are controller and HQ only,
  the founder runtime is unchanged, and Agent-1 stays on 7c194b8.
- No funding, adjustment or activation is involved.

## Group A on 1116576 (27 Oct, 20:09–20:20Z): PASSED; production unchanged

Approved by the owner for `1116576f3663a9f2289422b226b7e12232ff57ee`, the treasury display fix (v121, read-only) with HQ
0.27.0. All models were fake or absent: no paid call, no financial posting, no cutover.

| Step | Result |
|---|---|
| Push | `fleet/canary-prep` fast-forward `8e30120..1116576`, no force |
| Build (VPS, two passes) | Pins from pass 1's output (`~/rlc138/pins.txt`). Pass 2 verified **build `2c9907f2ebb809e814dc04183da139407a59c07e7e65ad367a91683a77e4b633`**, lockfile `1df54e35…` (unchanged) |
| Side-install (sudo) | `/opt/automaton-fleet/releases/1116576…`, identity re-verified; `current` stayed 7c194b8 |
| Data rehearsal `fleet-rollout.sh rehearse 120 → 121` | **PASSED 20:12:25Z.** Only 121 applies; privilege audit `ok`, no problems; 1,117 journals; ledger verify true; rerun no-op; the rollback dump restores 120 with the same head. "Counts moved while dumping" is informational (the agents' routine session renewals during the dump) |
| Services rehearsal `fleet-upgrade-rehearsal.sh 120 → 121` | **PASSED 20:13:15Z.** 7c194b8 refuses 121 (rollback = database restore); the candidate controller, Operator API and dashboard were ready on 121; rollback restored 120, and 7c194b8 was ready again; production PIDs unchanged |
| v121 on a disposable production copy (`copy-check.sh`; dropped) | See below |
| HQ 0.27.0 | See below |
| Rendered verification of the real built HQ | See below |
| Production before / after (20:09:36Z / 20:19:14Z) | See below |

**v121 on the disposable copy:**

- `treasury_position`: PayPal **£0.22 GBP** (fresh), **reconciled** (difference £0.00), available **£0.00**, owed to you
  £10.81, set aside £10.79, wallets £189.43 (backed at most £0.00), API credit $115.23 (USD, apart);
- Treasury health and Money states now carry the GBP balance;
- wealth: actual cash 22, available 0, reconciled; **`treasuryCashMinor` 1,079, unchanged** (= `fleet_treasury_cash()`);
- journals 1,117 before and after; ledger verify true; `dash_call` knows the read;
- live head and schema unchanged.

**HQ 0.27.0:**

- Two clean LIVE builds are identical: 52 files, artifact `20c8c13d3b7da2a904f41f9901faacb1354daae533ff59562b2fdb88d698c33c`.
- **Tarball `ui-0.27.0-1116576.tgz`, sha256 `bccb6e667859dcaa270477e9f00328c61e8c8aeeb089e2f95f24922de8ff2558`.** It
  has 71 entries, is root-owned with a fixed timestamp, and two packings are identical.
- Staged at `~/rlc138/`. `fleet-ui-deploy.sh --check`: "UI CHECK OK: 0.27.0 would be new; nothing changed". Production
  serves 0.26.2.

**Rendered verification of the real built HQ** (`hq-0.27.0-evidence/live-*.png`): HQ 0.27.0's LIVE build and the real
gateway, against a throwaway registry with **sample data**, signed in with password and authenticator, headless Chrome,
no page errors. With a GBP row (22) and a newer USD row (0):

- **Overview:** "Available treasury (backed): unknown — reconciliation unresolved"; "PayPal cash (actual): £0.22" (the
  GBP row, not the USD one).
- **Treasury headline:** the same.
- With the sample books reconciled: **Overview** "Available treasury (backed) £9,800.00" beside "PayPal cash (actual)
  £10,000.00", and the **Treasury headline** £9,800.00.
- The Treasury position panel agrees with both.
- **Money & identity:** "○ Bank details: not saved yet" above its form. The section text no longer reads as a status.
- The production-figure renders of the position panel and the four sealed states are `before.png` / `after.png`.

**Production before / after:**

- identical: schema 120, ledger head 1176 `e214852e…` (verify true), founder cognition, agents, state, units, unit
  files, packages, tools, settings, and the reconciliation snapshot outside events;
- both agents paused: Agent-1 7c194b8 PID 2135441, **Agent-2 b60e262 PID 866408**;
- **events 3,088 → 3,090:** two routine `session_opened` renewals by the paused agents (ids 11409–11410); permanent
  history 345, same digest;
- **off and closed:**
  - inference off (policy disabled, `FLEET_COGNITION_PROVIDER=none`);
  - Fleet Control budget unset;
  - sales closed;
  - no outward release, refund authority, custody activation or credit hold;
  - owner tasks 0;
  - the four flags false.

**Unchanged by decision:** replication and insolvency policy. `fleet_replication_health` and `svc_notify_tick` still read
the legacy book figure `treasuryCashMinor` (the treasury_cash partition sum). This is disclosed, not corrected.

### Stage 1 funding, stated precisely (correcting "Stage 1 needs no funding")

- **Agent-1's own work in Stage 1:** adopting the files, inspecting them, its deliverable review and any
  `independent_review`. These are its own model calls: Anthropic credit, promotional first, inside 754p/day, 120 turns/h
  and the $15 hold. **No PayPal money is needed for them.**
- **Fleet Control's calls are different, and their gate stays:**
  - spend reviews of material commitments;
  - lesson (knowledge) reviews if Agent-1 proposes a shared lesson;
  - evidence relevance;
  - message checks (none while sales are closed).

  Each must **reserve its maximum in GBP from `fleet:treasury:unallocated` before it runs** (v117), and its provider
  credit too. With unallocated at £0.00, such a reservation is refused (`FLEET_CONTROL_AI_BUDGET_UNFUNDED`), and the item
  waits unfunded: no call, nothing charged. That is the designed behaviour and is not removed.
- **So:** Stage 1's expected path, adopting the files and recording a review, needs no treasury money. Any Fleet Control
  review that arises during Stage 1 waits until the treasury is funded. The safety gate is intact.
- **The Stage 2 amount:** about 75p net is the minimum for one controlled order (30p message-check reserve + about 45p
  proof fee). It is settled, with its assumptions, before Stage 2. **No £5 transfer is justified to repeat the earlier
  test.**

### Group B package for 1116576 (prepared; NOT run; needs approval)

- **Script:** `install-1116576.sh` beside this record, **sha256
  `2b9122a123df4afdfd911264fb0793b47373c296216379ef92231b90bb954cf5`**, staged identically as `~/rlc138/install.sh`. It
  is generated from the 7c194b8 script with only these changes: the pins, Agent-1's current runtime (7c194b8), schema
  120 → 121, UI 0.27.0, and the v121 checks.
- **Run:** `bash ~/rlc138/install.sh`.
- **Pins:**
  - commit `1116576f3663a9f2289422b226b7e12232ff57ee`;
  - build `2c9907f2ebb809e814dc04183da139407a59c07e7e65ad367a91683a77e4b633`;
  - lockfile `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1`;
  - **UI 0.27.0**, `~/rlc138/ui-0.27.0-1116576.tgz`, sha `bccb6e667859dcaa270477e9f00328c61e8c8aeeb089e2f95f24922de8ff2558`.
- **Gates, checked before any change:**
  - the pins;
  - both rehearsals of 1116576 passed and are under 24 h old (**run before 20:12Z on 28 Oct**, else rehearse again);
  - the UI tarball checksum;
  - release directory present;
  - both agents paused, Agent-1 on **7c194b8** and Agent-2 on **b60e262**;
  - inference off;
  - permissions closed;
  - the four flags false;
  - schema 120 on 7c194b8;
  - no open credit hold;
  - no canary unit;
  - founder unit template identical;
  - `FLEET_ROLLOUT_AUTO_RESTORE` unset;
  - a fresh full-dump baseline (TOC checked), kept and never restored by the script.
- **Change:** `fleet-release.sh … 120 121 0.27.0 <tgz> <sha>`.
  - Backend cutover: a fresh dump, migrate 121, reconcile, approve the runtime, restart the controller-side units.
  - UI promotion: only `FLEET_DASHBOARD_STATIC_DIR` changes, to `/opt/automaton-fleet/ui/0.27.0`; rollback restores
    0.26.2.
  - Exactly one `production_deployed` or `production_rolled_back` event.
  - **No founder unit restarts. No agent runtime changes.**
- **Verification:**
  - controller ready;
  - both agents paused with the **same PIDs and runtimes**;
  - inference off;
  - tiers, ledger head, credit and owner payable unchanged;
  - v116–v120 checks still hold (owner tasks 0);
  - **v121:**
    - Treasury health shows the GBP balance;
    - the position reads;
    - the legacy `treasuryCashMinor` = `fleet_treasury_cash()` (unchanged);
    - the gateway knows `treasury_position`;
    - the dashboard serves UI 0.27.0;
  - unit files unchanged, flags false, permissions closed, ledger verified;
  - settings captured.
- **On failure:** no database restore. Controller-side units stop and you decide; the pre-install backup is kept.
- **Not included:** any task, funding, financial adjustment, credit hold, timer, inference, agent resume or sales opening.

## Group B INSTALLED (27 Oct, 20:24–20:26Z): 1116576 on schema 121 with HQ 0.27.0

Approved by the owner for `1116576f3663a9f2289422b226b7e12232ff57ee`, build
`2c9907f2ebb809e814dc04183da139407a59c07e7e65ad367a91683a77e4b633`.

**Checked before the run:**

- `~/rlc138/install.sh` sha256 `2b9122a1…4cf5`;
- pins;
- the HQ tarball sha `bccb6e66…2558`;
- rehearsals 12 minutes old;
- `FLEET_ROLLOUT_AUTO_RESTORE` unset.

**The run:**

- **Gates:** all passed.
- **Pre-install backup:** `~/rlc138/baseline-pre-install-1116576-20261027T202419Z`, 5,471 dump entries; kept, not
  restored.
- **Release 7c194b8 → 1116576, schema 120 → 121:**
  - **outage 20:25:23–20:26:10Z (47 s)**;
  - reconciliation OK;
  - `RELEASE 1116576 DEPLOYED 20:26:23Z: schema 121, root UI 0.27.0`;
  - one `production_deployed` event.
- **Verified by the script:**
  - Agent-1 7c194b8 PID 2135441 and Agent-2 b60e262 PID 866408, both paused, the same processes;
  - inference off;
  - ledger head, credit and owner payable unchanged;
  - v116–v121 checks;
  - owner tasks 0;
  - flags false;
  - permissions closed.

**Verified afterwards (read-only, 20:27Z):**

- `fleet_treasury_position`:
  - PayPal **£0.22 GBP**, fresh;
  - **reconciled**, difference £0.00 (books £200.22 − unbacked £200.00);
  - **available backed treasury £0.00**; unallocated 0, Fleet Control reserved 0;
  - **owner payable £10.81**, distinct from **set aside £10.79**;
  - **wallets £189.43** (Agent-1 £89.43, Agent-2 £100.00), **backed at most £0.00**;
  - API credit $115.2303348 free, $0 held.
- **Ledger:** head 1176 `e214852e…`, verify true. Credit balance 11,523,033,480 µ¢, unchanged.
- **Legacy `treasuryCashMinor`:** 1,079, unchanged, as decided.
- **The dashboard:**
  - `FLEET_DASHBOARD_STATIC_DIR=/opt/automaton-fleet/ui/0.27.0`;
  - the loopback and public `/` are byte-identical to the 0.27.0 `index.html`;
  - the bundle carries the new labels ("Available treasury (backed)", "PayPal cash (actual)", "Treasury position (what is
    real)", "not saved yet", "Show the saved …").
- **The production screens themselves need your sign-in:** you confirm them; Claude cannot sign in to HQ.
- Inference off, Fleet Control budget unset, no canary unit, both agents paused.

**UI rollback, if needed:** `dashboard.env.pre-0.27.0` (back to 0.26.2). **Backend rollback:** fix forward. The 120 dump
exists, but a database restore needs your explicit approval.

**Owner confirmation (27 Oct):** the saved vault address matches (checked through the passkey Show; the value was not
shared), and the corrected Overview, Treasury and sealed-item screens look correct on production. The display fix is
complete.

## Separate improvement (proposed; NOT implemented): authenticator at sign-in, password for routine confirmations

Owner, 27 Oct: "the authenticator is a bit of an overkill once signed in — authenticator should be used for sign-in and
anything else after that only needs a password — authenticator for every stage is getting frustrating."

**Today:** all 74 step-up operations (`SENSITIVE_OPS`) need a fresh password + authenticator code (`/api/stepup/password`),
or a passkey, bound to that one operation and its arguments.

**Proposed for review (no authentication change until you approve):**

**1. Keep the authenticator (or passkey) for a short high-risk list (21 operations):**

| Group | Operations |
|---|---|
| Money leaving, or payment authority | `owner_withdrawal`, `custody_activate`, `order_refund`, `destination_paypal_link`, `location_transfer`, `identity_autonomy_set` (standing authority to fill your card / facts), `card_slot_set`, `location_bind_card`, `outward_release` |
| Your sign-in and alerts | `passkey_revoke`, `totp_reset`, `push_device_add` |
| Secrets in or out | `reveal_request` (Show), `owner_vault_upload`, `custody_credential_upload`, `custody_credential_revoke`, `provider_secret_upload`, `identity_documents_set` |
| Irreversible agent life | `agent_kill`, `birth`, `reseed` |

**2. Password only for the other 53**, after an authenticator sign-in in the same session. These are policies, limits,
holds, reviews, card records and statements, attributions, consents, survival protection, the seller details, channels,
locations and so on. They remain step-up operations, bound to the operation, audited and rate-limited, but the code is
not asked for again.

**3. A reuse window, optionally combined with 1–2:**

- After an authenticator (or passkey) confirmation, high-risk operations in the **same session** accept the password
  alone for **15 minutes**.
- The window is never extended by password-only confirmations, and it ends at sign-out or on a failed attempt.
- `totp_reset`, `passkey_revoke` and `owner_withdrawal` always ask for a fresh code.

**Implementation, when approved:**

- the gateway accepts a password-only step-up only for the approved list, or within the window;
- the client asks for the code only when needed;
- tests for each class, the window's expiry and the failure reset;
- the usual Group A/B.

## Stage 1: FINAL approval package (27 Oct; NOT activated; needs your approval)

Agent-1 only. **Agent-2 unchanged:** b60e262, PID 866408, paused, 3,000p/day, 60 turns/h, no task. Sales and every
outward authority stay closed.

### Preconditions, read-only, checked again immediately before step 1

- release 1116576, schema 121, HQ 0.27.0;
- both agents paused (Agent-1 7c194b8, PID 2135441);
- inference off (policy disabled, `FLEET_COGNITION_PROVIDER=none`);
- Fleet Control budget unset;
- sales closed;
- no outward release, refund authority, custody activation, card or identity autonomy;
- no credit hold;
- no canary unit;
- owner tasks 0;
- ledger verifies (head 1176).

### Exact settings

| Setting | Now | Stage 1 | Enforced by |
|---|---|---|---|
| Agent-1 rolling 24 h AI usage | 754p | **754p** (unchanged) | controller refusal (v119: usage from every credit source + open reservations) |
| Agent-1 model calls per hour | 600 | **120** | controller refusal |
| Provider-credit ceiling | none | **hold `canary-agent1-ceiling` = balance − held − 1,500,000,000 µ¢** (now 11,523,033,480 − 0 − 1,500,000,000 = **10,023,033,480 µ¢**, recomputed by SQL just before) → exactly **$15.00 free** | controller refusal for every consumer (v119 one figure) |
| Fleet Control AI budget | unset | **30p/day** | its reservation **plus the existing funding gate**: unallocated treasury is £0.00, so every Fleet Control reservation is refused (`FLEET_CONTROL_AI_BUDGET_UNFUNDED`) and the review **waits** (no call, no charge) |
| Deadline | none | **ENDS_AT = STARTED_AT + exactly 7 days** (STARTED_AT = the resume in step 8; e.g. resumed 28 Oct 10:00:00Z → ends 4 Nov 10:00:00Z) | `automaton-fleet-canary-end.timer` (drop-in `OnCalendar=` ENDS_AT) and the hourly check after ENDS_AT |
| Hourly guard | none | cash charges > 1,000p, credit consumed > $15, ledger verification failure, repeated delivery or message, past ENDS_AT → **safe stop once** | `automaton-fleet-canary-check.timer` |

**Approval wording, kept verbatim:** $15 is an authorisation ceiling based on reserved estimates, not an unconditional
provider-billing guarantee; an underestimated call could exceed it and trigger a cost exception.

**Cash exposure at today's FX** (0.750296, by code): at most **£11.26 (1,126p)**, all of it Anthropic credit (promotional
first, $98.01). No PayPal money moves.

### Steps (one approval covers 1–8; sudo, `/etc` and the controller restart are named here)

1. `founder-cognition 01M3F50SH7PNX2E3GST13J52AS pause --turns-per-hour 120 "canary stage 1: 120 calls/h"`. Read back
   754p / 120 / paused.
2. `economy-fleet-control-ai-budget 30 "canary stage 1: Fleet Control 30p/day; unfunded calls wait"`.
3. Recompute by SQL, then
   `economy-engineering-credit-hold canary-agent1-ceiling anthropic <balance − held − 1500000000> "canary stage 1: exactly $15 free"`.
   Verify free = 1,500,000,000.
4. **Inference on.** The key is copied root to root, never displayed, printed or logged:
   - `/etc/automaton-fleet/recovery/cognition.key.20261023T142625Z` → `/etc/automaton-fleet/cognition.key`, 0600,
     owner automaton-fleet-service;
   - service.env: `FLEET_COGNITION_PROVIDER=none` → `anthropic`, plus
     `FLEET_COGNITION_API_KEY_FILE=/etc/automaton-fleet/cognition.key` (model, thinking, effort and timeouts
     unchanged);
   - `cognition-enable anthropic claude-opus-5-5 --max-output 4000 --in-microcents 400 --out-microcents 2000`, then read
     back all four prices (cache 20 / 500 unchanged) and the tiers (T1 / T2 / T3 enabled, verified);
   - `systemctl restart automaton-fleet`, then readyz 200.
   - Verify: both agents still paused, Agent-2 identical.
5. **Guard:**
   - `~/canary/canary.conf`: CANARY_ID=agent1-c1, AGENT=01M3F50SH7PNX2E3GST13J52AS,
     OFFER_SLUG=uk-landlord-compliance-tracker-england-g-a9ddde, STARTED_AT / ENDS_AT (set in step 8),
     CASH_CEILING_MINOR=1000, CREDIT_CEILING_USD_MICRO=1500000000, HOLD_RUN=canary-agent1-ceiling;
   - the four units from the release, and the end-timer drop-in;
   - `fleet-canary.sh check --dry-run` and `end --dry-run` must write nothing;
   - `systemctl enable --now` on both timers, after step 8 has fixed ENDS_AT.
6. **Files:** copy the candidate (xlsx `7793dff2084dd7968019041e7579ecdedafd73529190c14b8a85a39820bc69b5`, README
   `4494dff2…`) into Agent-1's `workspace/…/from-owner/tracker-v6/`, owner fnd-01M3F50SH7PNX2E3GST13J52AS, 0600, with
   hashes verified after copying. The live offer's files are not touched.
7. **Owner task** (`founder-task`, about 1,000 characters; shown in every working turn until closed):

   > **Title:** Adopt the corrected tracker files and review them
   >
   > Adopt the corrected files for your offer "UK Landlord Compliance Tracker (England)" (offer d7063a0a, slug
   > uk-landlord-compliance-tracker-england-g-a9ddde). The corrected workbook is in your workspace at
   > from-owner/tracker-v6/Landlord_Compliance_Tracker.xlsx
   > (sha256 7793dff2084dd7968019041e7579ecdedafd73529190c14b8a85a39820bc69b5). It fixes printing: columns were cut off
   > on printed pages. 1) offer file remove: tracker.zip (the September CSV version, 10adb667…) and
   > Landlord_Compliance_Tracker.xlsx (f45c3d00…). Keep README.txt (4494dff2…, unchanged). 2) offer file: attach the
   > corrected workbook as a deliverable. 3) deliverable inspect both files with your acceptance cases, and look at the
   > printed pages. 4) deliverable review, subject offer, of exactly those two files. If you find a defect, fix it and
   > review your fixed file instead. **Do not publish:** sales stay closed until the owner's next step. When the review
   > is recorded, stop work on this offer and wait (sleep, naming the review), and do not start other paid work. If
   > something blocks you, record the blocker once and wait.

8. **Resume:** `founder-cognition 01M3F50SH7PNX2E3GST13J52AS resume "canary agent1-c1 stage 1"`. Its timestamp is
   **STARTED_AT**, and ENDS_AT = +7 days is written to canary.conf and the end timer before the timers are enabled.

### When the task finishes

Stage 1 passes when:

- the offer's deliverables are exactly the two files;
- a fleet-qa-3 offer review passes with files_digest `f3e6193aafe44a8d5cf55809082cd7efb1aa8c9abd7c8514e4f3ceb7710d6c69`
  (or a re-quoted digest if Agent-1 fixed the file itself);
- the offer is **not** published;
- no stop fired, and the ledger verifies.

Then, to avoid any further paid wake:

1. **Pause Agent-1 first** (`founder-cognition … pause "stage 1 complete"`). A paused agent makes no model call.
2. **Then close the task** (`founder-task-close <taskId> "review <id> recorded"`). Closing changes the task digest, which
   would wake a running agent; paused, it costs nothing.

The hold, the 30p budget and the timers stay as they are until Stage 2 is approved, or until ENDS_AT runs the safe stop
and releases the hold (only when no reservation is open).

Even before the pause, a finished agent that declares its wait makes **no** model call until something relevant changes:
the production runtime has no timed safety re-check. An undeclared rest is capped at a few full re-checks a day, inside
754p/day.

### When the task is blocked

- **A Fleet Control review is needed** (for example a spend review): the reservation is refused while the treasury is
  unfunded. Only that item waits; Agent-1 is told and can declare its wait. Nothing is charged and nothing retries in a
  paid loop.
- **A tool or inspection fails repeatedly:** the loop guard remembers the refusal across wakes and restarts, so it is not
  retried unchanged. A stalled founder gets **one** assessment turn, then waits with **zero** inference until a
  relevant change.
- **No passing review within 24 h of STARTED_AT**, or a recorded blocker:
  - pause Agent-1;
  - report the evidence (its turns, usage, blocker);
  - you decide (fix, adjust the task, or end).

  No automatic retry.
- **Automatic stops still apply:** 754p/day, 120 calls/h and the $15 hold refuse further calls, and the hourly guard runs
  the safe stop once on a breach (pause, offer hold, sales closed, Fleet Control budget off).

### Not in this approval

Funding or any financial entry; Stage 2 (sales, the proof order, the refund); Stage 3 (public acquisition, which needs
Agent-1's evidence-backed offer first); publishing; Agent-2; any authentication change.

## Stage 1 preflight (27 Oct): STOPPED before any change — the 24 h checkpoint and blocker stop are not persistent

Stage 1 was approved subject to preflight conditions. One failed, so **no Stage 1 step was taken**:

- no hold;
- no key copy or `service.env` edit;
- no controller restart;
- no timer;
- no file copy;
- no owner task;
- Agent-1 still paused.

**Condition: the persistent guard must enforce the 24-hour review checkpoint and the reported-blocker stop.**

**Result: it does not.** `fleet-canary.sh check` (hourly, systemd) runs the safe stop only on:

- ledger verification failure;
- agent cash charges > CASH_CEILING_MINOR;
- provider credit consumed > $15;
- a repeated delivery;
- a repeated buyer message;
- ENDS_AT.

Its measures (`fleet-canary-measures.sql`) read neither offer reviews nor blockers. A blocker recorded by Agent-1
(`capabilities.request` → `fleet_capability_demands`, or an owner / dependency request → `fleet_owner_requests`) reaches
Fleet Command and the owner's notifications, but stops nothing. The 24-hour checkpoint exists only as an instruction in
this record. **Both therefore depend on this Claude session.** As instructed, nothing extra was implemented under this
approval.

**Read-back (read-only, before any change). Model assignments are preserved as they are:**

| | |
|---|---|
| Policy | anthropic `claude-opus-5-5`, max output 4,000; prices per token: input 400 µ¢, output 2,000 µ¢, cache read 20 µ¢, cache write 500 µ¢; **disabled**; `FLEET_COGNITION_PROVIDER=none`; model / thinking adaptive / effort medium / 150 s / 180 s in `service.env` |
| Tiers (routing on; both founders routed) | T1 `claude-haiku-4-5-20251001` (enabled, verified 30 Sep, max 2,000); T2 `claude-sonnet-5-5` (enabled, verified, adaptive, max 8,000); T3 `claude-opus-5-5` (enabled, verified, adaptive, max 16,000) |
| Agent-1 | paused, 754p/day, 600 calls/h, 7c194b8 |
| Agent-2 | paused, 3,000p/day, 60 calls/h, b60e262 |
| Credit | 11,523,033,480 µ¢, held 0; the hold for $15 would be 10,023,033,480 µ¢ |
| FX (USD) | 0.750296 (27 Oct) |

**Two ways to make the checkpoint and blocker stop persistent (for your decision; neither started):**

**A. No code change: a 24-hour Stage 1 deadline on the existing end timer.**

- Set Stage 1's ENDS_AT = STARTED_AT + **24 h**, instead of 7 days.
- At 24 h the persistent end timer runs the safe stop whatever happened: pause, offer hold, sales closed, Fleet Control
  off. It releases the hold only if nothing is open.
- That enforces the checkpoint persistently. **A blocker is not detected as such**, but its cost stays bounded by
  754p/day, 120 calls/h and the $15 hold, and it ends at 24 h.
- Stage 2 would then re-establish the hold, timers and budget under its own approval.
- This changes the approved deadline (7 days → 24 h for Stage 1), so it needs your word.

**B. Small guard extension (code; separate approval and a release).**

- `canary.conf` gains `REVIEW_BY` (STARTED_AT + 24 h) and `REVIEW_DIGEST` (`f3e6193a…`).
- The measures gain:
  - `reviewPassed`: a passing offer review of that digest by Agent-1 since STARTED_AT;
  - `blockersSince`: Agent-1's capability demands and owner / dependency requests since STARTED_AT.
- The hourly check runs the safe stop on: `now ≥ REVIEW_BY` and no passing review; or any blocker since STARTED_AT.
- Tests: stub cases for both stops and their non-stops, plus the PostgreSQL measures test.
- It ships in the release, because the units run the installed `scripts/fleet-canary.sh`. That means Group A/B, scripts
  only, schema unchanged.
- The 7-day deadline then stays as approved.

## INCIDENT 2026-10-27: both founders died after a controller outage during Stage 1 (launch suspended)

### Timeline (UTC)

1. **21:12:45–21:12:47** — Stage 1 steps 1–3:
   - Agent-1 at 120 calls/h (paused);
   - Fleet Control 30p/day;
   - hold `canary-agent1-ceiling` 10,023,033,480 µ¢ ($15 free).
2. **21:13:03** — Step 4:
   - key copied to `/etc/automaton-fleet/cognition.key` (0600 service user; byte-identical; never displayed);
   - `service.env` backed up (`service.env.pre-stage1-20261027T211303Z`);
   - `FLEET_COGNITION_PROVIDER=anthropic` and the key-file line added.
3. **21:13:19** — `cognition-enable` (21:13:20), then the controller restart. **The controller refused to start:** a cloud
   provider needs `FLEET_INFERENCE_PROFILE=cloud_allowed` (the 23 Oct local-only directive, 17019f2). Crash loop, then
   systemd gave up.
4. **21:15:05** — `service.env` restored from the backup (the failed one is kept as
   `service.env.failed-stage1-20261027T2114Z`). Controller up (PID 2198059). Policy disabled at 21:15:34.
5. **21:15:07** — The reaper marked **both** founders `unresponsive` (last heartbeat 21:13:01, more than 120 s earlier).
   **21:15:31** — Both founders exited by design (exit 3: "no longer accepts this founder").
6. **21:19:21** — Founder units restarted by the owner. They heartbeated, but **every health-challenge answer was refused**
   (`POST /v1/health/challenge` 400 `FLEET_GENESIS_REQUIRED: a founder advances only through its Genesis state machine`).
   Challenges expired at 21:20:23, 21:21:23 and 21:22:24.
7. **21:21** — Operator challenge request refused: `KEY_EXPIRED` (the bridge key expired on 25 Oct).
8. **21:23:07** — The reaper ended both: `agent_died` cause `health_timeout` ("unresponsive (unhealthy) for more than
   480 s"); estates frozen and settled; slots released. **Living agents: 0.**

### Root causes

- **R1 (latent since v11): a Genesis founder can never recover from `unresponsive`.**
  - `fleet_agents_origin_guard` forbids a founder's status changing to `active` outside a Genesis operation.
  - Recovery (`fleet_heartbeat`'s unresponsive → active after a passed challenge) is exactly that change, so the challenge
    transaction raised and was rolled back. Nothing was recorded as passed.
  - Any outage of over 120 s therefore kills every founder within 8 minutes.
- **R2: the controller outage counted against the agents.**
  - The reaper resets its grace window only when it has itself been idle for more than 120 s (`reaper_resumed`).
  - The outage was about 106 s, so no grace applied. The agents' last heartbeat (21:13:01) was more than 120 s old when it
    resumed.
  - Survival protection covers economic exhaustion, not health timeouts. `fleet_begin_termination` has no hold or
    protection check, and an agent without a sandbox goes straight to `dead`.
- **R3 (mine): the activation preflight missed the inference profile.**
  - The Stage 1 package and preflight never checked `FLEET_INFERENCE_PROFILE`.
  - I restarted a production controller with live agents attached without confirming every startup precondition.
- **R4: the operator recovery path was unavailable.** The `bridge-claude` key expired on 25 Oct 15:38Z, unnoticed.

### Effects (production, read-only)

- Agents dead:
  - Agent-1 (7c194b8, health "challenge expired unanswered", 3 failures);
  - Agent-2 (b60e262, same).
- Both founder units `failed`. Cognition rows still `paused=true`.
- **Journal 1177:** `estate_transfer`, Agent-1 cash 8,943 → `fleet:treasury:unallocated`.
- **Journal 1178:** `estate_transfer`, Agent-2 cash 10,000 → `fleet:treasury:unallocated`.
- **Journal 1179:** `ai_credit_acquisition_cost`, 186p. D `fleet:expense` / D owner_reimbursable; C `fleet:owner:payable`
  / C unallocated (key `ai-credit-cost:05f4cb13…:treasury:190`).
  - Treasury-paid acquisition cost had been waiting because `unallocated` was 0.
  - It posted the moment the estates moved **unbacked** wallet money into `unallocated`.
  - **Unallocated is now 18,757p of book money that is unbacked.** Every gate keyed on that balance would pass on virtual
    money: Fleet Control reservations, owner conversations, refund bookings, acquisition costs.
- Ledger 1179, verify true. Credit $115.23; hold 10,023,033,480 µ¢ still held; nothing in flight; no open Fleet Control
  reservation or cost exception.
- Founder state intact: Agent-1 1,089 files / 30 MB, Agent-2 15 files. Release, flags and cap unchanged.

### Evidence (`~/incident-20261027/`, `SHA256SUMS`)

- database dump `db-20261027T213204Z.dump` (5,475 entries);
- controller and founder journals 20:20–21:30;
- sudo log;
- config checksums;
- both founder state directories (`state-<id>-*.tgz`);
- the upgrade backup `/var/lib/automaton-fleet-upgrades/cc7e1df3…` (28 MB) is kept.

**No teardown or cleanup.**

### Containment (prepared, NOT run; needs approval)

`~/incident-20261027/contain.sh`, sha256 `78f6f1c6279f79444443c675ba962040c32418b266f705a0904525ec0b6b8f71`.

- **Two reversible, audited actions:**
  - Fleet Control budget **off**;
  - spend circuit breaker **tripped**.
- **Assertions:**
  - evidence intact;
  - cognition disabled and provider `none`, with no key-file line;
  - 0 living;
  - nothing in flight;
  - sales closed;
  - flags false.
- **Kept:** the credit hold (until no unresolved calls or spending paths remain, verified separately) and the key file
  (unused).
- No posting, no lifecycle change, no restore.

### Next (not authorised yet)

Recovery is demonstrated only on a disposable copy: the same identities, memory and workspaces, compensating entries
rather than deleted history, and fresh challenges passing. If no supported path exists, the smallest tested procedure
comes for explicit approval.

### Containment RUN (27 Oct 21:37:57–21:37:59Z, owner-approved; `contain.sh` sha256 78f6f1c6…8f71 verified first)

- Fleet Control budget **off** (event 11479); spend circuit breaker **tripped** (event 11480).
- Verified afterwards:
  - inference disabled, provider `none`, no key-file line;
  - sales, outward release, refund authority and custody closed;
  - ledger 1179 unchanged and verifying;
  - credit hold 10,023,033,480 µ¢ and key file (`01a24123…`) unchanged;
  - agents still `dead`.
- Evidence intact (9 files).

### Investigation results

1. **Why heartbeating founders failed every challenge (R1).**
   - At 21:15:31 the founders' **heartbeat itself** returned 400 `FLEET_GENESIS_REQUIRED`. `fleet_heartbeat` correctly tried to
     restore them to `active` (last passed challenge 21:12:31, inside the 300 s health grace), and `fleet_agents_origin_guard`
     aborted it, so the founders exited (code 3).
   - After the restart every `svc_answer_challenge` hit the same guard on its `unresponsive → active` update and was rolled
     back (400). Failures accumulated to 3, then death.
   - With R1 repaired, the 21:15:31 heartbeat alone would have recovered both.
2. **Why downtime counted (R2).**
   - `fleet_reap` restarts its grace window only after a reaper gap of more than `heartbeat_unresponsive_s` (120 s). The
     outage gap was about 106 s, so there was no `reaper_resumed`.
   - The founders' last heartbeat (21:13:01) was more than 120 s old at the reaper's first pass after the restart.
   - Survival protection covers economic exhaustion only. `fleet_begin_termination` has no protection check.
3. **Journals 1177–1179.**
   - 1177 / 1178: `estate_transfer`, each wallet's book cash (8,943 / 10,000) to `unallocated`.
   - 1179: the waiting **treasury** AI-credit acquisition cost (accrual `05f4cb13…:treasury`, 186p), which `fleet_ai_credit_cost_pass`
     posts only when `unallocated` covers it. It posted the moment the estates put money there.
4. **Unbacked estate money passed treasury gates.** Yes: `unallocated` became 18,757p of unbacked book money, which every
   `unallocated`-keyed gate would accept (Fleet Control reservations, owner turns, acquisition costs, refund bookings).
5. **The expired operator credential and the failed preflight.**
   - The `bridge-claude` key expired on 25 Oct 15:38Z, unmonitored; rotating it is `fleet:bridge key rotate-prepare` plus the
     owner's registration (not done).
   - The activation preflight never checked `FLEET_INFERENCE_PROFILE` (the 23 Oct local-only directive, 17019f2).

**Effects of each death, from a diff of the pre-incident (20:24Z) and incident (21:32Z) dumps:**

- `fleet_agents` → dead, `death_time`;
- credentials revoked;
- `fleet_founder_cognition` enabled=false;
- wallet `spending_frozen` "agent dead";
- `fleet_estates` settled (cash only);
- `living_agents` 2 → 0;
- journals 1177–1179;
- history: events, feed, challenges.

Identity, ledger accounts, memory and workspace files were not touched.

### v122 founder recovery (local candidate; NOT deployed)

`src/fleet/postgres/migrations-phase122.ts`:

- **R1:** the founder guard allows exactly `unresponsive → active`. Every other founder advance still needs Genesis.
- **R2:** a reaper gap of more than **45 s** (three 15 s periods) restarts the grace window.
- **R3:** `fleet_admin_incident_reinstate(incident, agents[], unwindJournals[], actor)`, owner and `fleet_genesis` approver;
  **atomic**.
  - **Refuses:**
    - anything but a dead founder without a sandbox that died within 14 days of a **health or heartbeat timeout**;
    - an estate that moved more than cash, or that received money after settling;
    - a credential not revoked at death;
    - the cap.
  - **Does:**
    - **mirrored reversals** of the acquisition cost (back to waiting; `unwound_minor` records it, so keys never repeat) and of
      each estate transfer;
    - estate `reverted`, with an append-only `fleet_estate_reversions` record;
    - dead → `unresponsive` under a reinstatement-only, same-agent allowance;
    - only the credential and wallet freeze from death restored;
    - cognition enabled but **paused**;
    - a challenge due at the next heartbeat;
    - `agent_reinstated` / `estate_reverted` / `ai_cost_unwound` events.
  - The ledger must verify and `unallocated` must stay non-negative, or it all rolls back.
- **R4:**
  - Estate cash up to the still-unbacked starting capital goes to `fleet:treasury:unbacked_estates` (treasury_cash; the
    reconciliation is unchanged), never `unallocated`.
  - The estate freeze reopens a reverted estate.
  - Estate journal keys carry a suffix after a reversion.
- CLI `founder-reinstate "<incident>" <ids> [<unwind ids>|-]`.

**Tests (local):**

- `tsc` clean.
- **New** `fleet-v122-founder-recovery-pg` **6/6**:
  - clean audit;
  - R2 with the incident's 106 s / 126 s;
  - R1 heartbeat recovery inside the health grace, and challenge recovery after it;
  - the incident replayed (death at 480 s while heartbeating; estates settle; R4 keeps unbacked cash out of `unallocated`;
    a dead agent refuses an ordinary move even for a superuser);
  - reinstatement (same credential rows, mirrored reversals, cost back to waiting, paused, active only after a passed
    challenge, ledger verifies, refused twice);
  - re-death opens and settles a new estate (2 transfers, 1 reversion);
  - refusals for a non-owner and an economic death.
- **Rerun:**
  - d31-hardening 18/18;
  - v111 10/10;
  - static audit 6/6;
  - v72 5/5;
  - v120 6/6;
  - phase4 53/53;
  - genesis 25/25;
  - v121 5/5;
  - survival protection 4/4.
- **Pre-existing, disclosed:** `fleet-event-routing-pg` "routes every event type" fails with 84 unrouted types. 79 predate
  this work (the test imports route tables only up to v74; e.g. v106's `owner_claim_waits`, 597acc1). The other 5 are v120's
  `owner_task_*` and v122's three events, all routed in the database by their migrations.

### Demonstration on a disposable copy of production after the deaths (27 Oct ~21:58Z; `recovery-demo.sh`, `recovery-demo.log`)

The incident dump was restored into `fleet_recovery_demo`, with candidate tooling 1116576 + `v122.patch` in `/var/tmp`.
There were no providers or credentials, and **the live database was not touched** (head 1179 `1e64694c…` before and after).
The copy was dropped.

**Before:** schema 121; both `dead`; living 0; unallocated 18,757; head 1179.

**Steps:**

1. Migrate to 122; privilege audit `true []`.
2. **The exact proposed call:**
   `fleet_admin_incident_reinstate('INCIDENT 2026-10-27 controller outage', [Agent-1, Agent-2], [1179 3cb79f23…], 'operator:ubuntu')`
   returned `ok`. It unwound 1179 (186p) and reinstated both (cause `health_timeout`).

**After:**

- Both `unresponsive`, paused, cognition enabled, credentials valid, wallets unfrozen, estates `reverted`, cash 8,943 /
  10,000.
- **Identity unchanged** (agent id + credential token hash; wallets).
- Living 2 / cap 2. **Unallocated 0**, unbacked_estates 0, owner payable 1,081, set aside 1,079.
- **Mirrored corrections:** 1180 reverses 1179, 1181 reverses 1177, 1182 reverses 1178. The originals and both `agent_died`
  events are kept.
- The cost is back to waiting (unposted 186,873,308 µ¢, posted 190, unwound 186).
- **Ledger verifies; capital reconciliation 0.**

**Fresh challenges:**

- Each founder heartbeats (`unresponsive`), then answers the challenge with its real runtime identity: `{"ok":true}` →
  **`active`**.
- This used the controller's own issue / answer functions at registry level; no founder process or credential was used.
- Policy disabled, both **paused**, ledger verifies.

**Downtime cannot repeat this:** with the incident's numbers (106 s reaper gap, heartbeats 126 s old), both stay
**`active`** (`reaper_resumed` 1).

**Memory and workspaces:** the live state directories are **byte-identical** to the incident-time archive (Agent-1 1,089
files `33ce2404…`, Agent-2 15 files `e27bc48f…`). The recovery does not touch them.

### Proposed production recovery procedure (for explicit approval; NOT authorised)

**Approval 1: release v122 (Group A, then Group B).**

- **Group A:** push, two-pass build, side-install, data and services rehearsals 121 → 122, and this demonstration rerun on a
  **fresh** dump with the release's own tooling, including the CLI `founder-reinstate`.
- **Group B:** the install.
- The controller restart is safe for founders: both are dead, and R1/R2 make future restarts survivable.
- No agent runtime change.

**Approval 2: the reinstatement window** (after Group B; preflight first, then one call, then the founder units within 8
minutes).

1. **Preflight (read-only).** Stop on any mismatch.
   - schema 122;
   - both `dead`, cause `health_timeout`;
   - estates settled, cash-only;
   - 1179 unreversed;
   - living 0 / cap 2;
   - containment in force (breaker tripped, Fleet Control off, inference off, provider none);
   - founder state digests equal the incident archive;
   - founder units `failed` (not running);
   - a fresh full dump plus SHA256SUMS.
2. **Reinstate:**
   `founder-reinstate "INCIDENT 2026-10-27 controller outage" 01M3F50SH7PNX2E3GST13J52AS,01M4C4NXT786Q4E9725N5A15KV 3cb79f23-c4fa-4aaa-a090-a5dfe1a2c0fd`
   (atomic; either everything or nothing).
3. **Within 8 minutes:** `systemctl reset-failed` and `start` both founder units. The runtimes are unchanged: Agent-1
   7c194b8, Agent-2 b60e262. Each heartbeats, receives the due challenge, answers it, and becomes `active`.
4. **Verify:**
   - both `active` and **paused**;
   - inference off;
   - journals 1180–1182 are the three mirrored reversals;
   - unallocated 0; ledger verifies; reconciliation 0;
   - breaker tripped; Fleet Control off; hold and key unchanged.
5. **If a founder is not `active` within 5 minutes:** report. The agent stays protected for the remaining grace. A second
   death would leave it reinstatable again (the re-death path is tested), but nothing is retried automatically.

**Not included:**

- funding;
- inference;
- an agent resume;
- releasing the hold;
- key rotation;
- Stage 1;
- changing replication or insolvency policy.

## Recovery checks before reinstatement approval (27 Oct; LOCAL and disposable copies only; production unchanged)

Nothing was pushed, installed, reinstated, restored, rotated or paid. The live database was read only by `pg_dump` into a
disposable copy (`fleet_recovery_demo`, dropped at the end); the live ledger head stayed 1179 `1e64694cbc6821e781a`, and both
live founders are still `dead`. The incident history is kept: both `agent_died` events, estates 1177 / 1178 and the
acquisition cost 1179 remain, and every correction is a mirrored reversal (1180 → 1179, 1181 → 1177, 1182 → 1178) on the
copy only.

### 1. Real founder processes (synthetic identities, the agents' own runtimes)

`src/__tests__/fleet/fleet-v122-recovery-real-founders.test.ts` runs a real founder process through `ProcessFounderHost`
from git-archived release trees of **7c194b8c2348…** (Agent-1's runtime) and **b60e262bf739…** (Agent-2's runtime). The
controller is this candidate's `FleetService` with its real reaper (`startReaper()`, 1 s interval). It uses a synthetic
Genesis founder (FounderProvisioner), cognition paused, with no provider and no production credential. The health window
is shortened (`heartbeat_unresponsive_s` 6).

Each runtime passes the same three phases (2 / 2 pass):

1. **Unresponsive → active by its own heartbeat.** It keeps the same process id (R1: a founder recovers instead of being
   blocked with `FLEET_GENESIS_REQUIRED`).
2. **A 9 s controller outage.** The founder stays `active` with the same process id. The test checks that the reaper
   actually ran and resumed (`reaper_resumed` ≥ 2), so this is not a vacuous pass (R2).
3. **Death, then reinstatement.** The process is stopped and the founder dies by `health_timeout`, and its estate settles.
   Then `fleet_admin_incident_reinstate(…, 30 min hold)` runs and the process restarts: **heartbeat → challenge → active**.
   - The hold is cleared and the last challenge passed.
   - The process id is new; the agent id, credential, accounts and state files are identical; the workspace is intact.
   - It has 0 `cognition_log` rows and is still paused, and the ledger verifies.

On the production copy (`~/incident-20261027/recovery-demo.sh`, sha256 `db16ed9089cd90ea…`; log `recovery-demo-final.log`
`c13e7915e3d6f0b5…`; patch `v122.patch` `2f6717269f37bab5…`), both real identities show **heartbeat → unresponsive**, then
**challenge `{"ok":true}` → active**:
- policy enabled f, both paused;
- each hold set until +60 min, and 0 holds left after active;
- unallocated 0, unbacked_estates 0, capital reconciliation 0;
- the incident's own numbers (a 106 s reaper gap, heartbeats 126 s old) leave both `active`.

### 2. The cap refusal rolls back the whole transaction

The v122 PG test lowers the cap to 1 (`setMaxAgents(1)`) and asks for a two-agent reinstatement. The result is
`FLEET_CAP_EXCEEDED`. A full snapshot taken before and after is identical:
- agent status, death fields, credential revocation, wallet freeze, cognition flags and hold;
- every ledger balance and the journal count;
- estates, estate reversions, the accrual (unposted / posted / unwound) and `fleet_events`.

There are no reversals, no unfreeze and no events. The non-owner refusal and the out-of-bounds hold refusal (4 and 121 min)
are checked against a fresh snapshot in the same way. An economic death is refused, because only `health_timeout` deaths
from the named incident are eligible.

### 3. The recovery window fails safely (implemented, bounded)

The design avoids automatic termination during verification without relying on a second death:

- The reinstatement sets `lifecycle_hold_until = now() + hold`, with the owner choosing **5–120 min** (anything else is
  refused). The agent comes back **unresponsive, paused, cognition enabled but with no inference**.
- While held, the reaper neither marks the agent unresponsive nor terminates it for heartbeat or health. Both clauses are
  in `fleet_reap` behind `lifecycle_hold_until IS NULL OR lifecycle_hold_until <= now()`.
- Once the hold ends, the full grace window counts **from the end of the hold**, not from the death or the reinstatement.
- A passed challenge (→ active) clears the hold through the stamps trigger.
- `fleet_admin_lifecycle_hold_end` (owner only) ends the hold early with a P2 event; the full grace then runs from that
  moment (tested: an agent unresponsive for 9 min is not killed at once).
- Only an owner reinstatement can set a hold. The hold does not affect economic rules, the owner's own kill, spending
  freezes or the paused cognition.

The test shows that an agent held and aged 9 min (and 11 min) past its unresponsive start does not die; the ordinary grace
applies again only after the hold.

**Remaining fallback, stated plainly:** if verification fails and the owner neither finishes nor extends it, the agent
returns to normal rules once the hold lapses. It would then die after the normal grace. That second death keeps the
original evidence and opens a new estate with a distinct key (tested), but it is not the recovery plan. The procedure
avoids it as follows:
- ~~start both founder processes before the reinstatement transaction;~~ **CORRECTED (Group A, below): reinstate FIRST, then start the units. A founder started against its dead record exits 3 and is never restarted;**
- reinstate with **60 min**;
- verify;
- if the challenge has not passed within 30 min, **stop and report** before the hold lapses.

**Proposed for approval (NOT built):** `fleet_admin_lifecycle_hold_extend(agent, minutes, reason, actor)`.
- Owner only, and only on an agent already under a reinstatement hold.
- Each extension is 5–120 min, with at most 24 h in total since the reinstatement.
- Each extension emits a P2 `lifecycle_hold_extended` event.

This would let a slow verification continue without a death and without an unbounded "immortal" state. Without your
approval it is not added, and the 120 min ceiling stands.

### 4. The estate partition: real funds stay backed; only unbacked capital is parked

Per agent at death:
- `earnings = GREATEST(0, external customer revenue − its treasury contributions)` stays in `unallocated`.
- `parked = LEAST(GREATEST(0, cash − earnings), fleet unbacked capital − already parked)` goes to
  `fleet:treasury:unbacked_estates`, which is treasury cash, so the capital reconciliation does not change.

| Case (PG test) | Cash | Kept (unallocated) | Parked |
|---|---|---|---|
| Unbacked capital only (the incident) | wallet | 0 | all, up to the fleet's unbacked capital |
| **Mixed**: 10,000 capital + 3,000 customer revenue − 1,000 spend | 12,000 | **3,000** | **9,000** |
| The fleet's unbacked capital is already used up | cash | cash − left | `left` = capital-backing unbacked − parked |
| Earnings exceed the cash left (3,000 revenue, 4,000 spend) | 9,000 | 9,000 | **0**; reconciliation unchanged |

A reinstatement reverses the estate with a mirrored journal and records `fleet_estate_reversions`. A later death opens a
new estate under a reversion-suffixed key.

### Event routing: new coverage vs the pre-existing failure

- **New in this candidate (4):** `agent_reinstated` (P1), and `estate_reverted`, `ai_cost_unwound`,
  `lifecycle_hold_ended` (P2). All four are routed in the database, and the v122 PG test proves it through
  `fleet_event_route`.
- **Pre-existing:** the static check in `fleet-event-routing-pg` ("routes every event type the code emits") imports route
  tables only up to v74. Run against 1116576 (production), it already finds **81** emitted types it cannot see, including
  v106 `owner_claim_waits` and v120 `owner_task_sent` / `owner_task_closed`. On the candidate it finds **85**: the 81 plus
  the 4 above.
- The other 12 tests in that file pass. The test was not changed or weakened. Fixing it means importing the v75+ route
  tables, which is separate work.

### Test results (candidate, targeted)

| Suite | Tests | Result |
|---|---|---|
| v122 founder recovery PG | 11 | pass |
| v122 recovery with real founder processes (7c194b8, b60e262) | 2 | pass |
| d31 18, phase4 53, genesis 25, survival v55 4, v111 10, static audit 6, v72 5, v120 6, v121 5, projects 21, births 4, migration paths 2 | 159 | pass |
| event routing PG | 13 | 12 pass; 1 pre-existing failure (above) |
| `tsc --noEmit` | — | clean |

### Group A scope for this candidate (proposed; NOT authorised)

1. Push the candidate to fleet-origin, without force.
2. Two-pass build on the VPS; take the pins from its output.
3. Side-install, not cut over.
4. Data and service rehearsals 121 → 122 on disposable copies.
5. Rerun the recovery demonstration on a fresh production dump using the release's own tooling:
   `founder-reinstate "<incident>" <ids> <unwindIds> 60`, plus `founder-hold-end`.
6. Founder upgrade and revision rehearsals with the fake provider.
7. Check that production is identical before and after.

Not in Group A: install, reinstatement, the hold extension, key rotation, funding, activation, resume or any paid call.

## Group A on c448d98 (27 Oct, 22:42–23:00Z): PASSED except the founder rehearsals (refused by their own guard); production unchanged

The owner approved Group A for `c448d98a1c32c63af89288758240fc5787f9f9d6`. Only disposable databases, synthetic process
credentials and the fake provider (or none) were used. There was no paid call, no financial posting, no reinstatement and
no cutover.

| Step | Result |
|---|---|
| Docs head | Before the push, `fleet-origin/fleet/canary-prep` was 1116576. The push was a fast-forward `1116576..c448d98` with no force: 6 docs commits (9597186 … c7ef757) and the v122 commits c4b52ae and c448d98. This record's file at c448d98 has sha256 `9ddd0527627a8561…`. A secret-pattern scan of the range was clean |
| Build (VPS, two passes) | Pins came from pass 1's output (`~/rlc139/pins.txt`). Pass 2 verified **build `48c0015ed443e23e835eed697ff5bc01275509d23fd13783a21f2422ad7c5725`** with lockfile `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Side-install | `/opt/automaton-fleet/releases/c448d98…`, identity re-verified; `current` stayed 1116576 |
| Data rehearsal `fleet-rollout.sh rehearse 121 → 122` | **PASSED 22:45:21Z.** Only 122 applies. The privilege audit is `ok` with no problems. 1,120 journals, ledger verify true, rerun is a no-op, and the rollback dump restores 121 with the same head (dump `3f4d47ea…`) |
| Services rehearsal `fleet-upgrade-rehearsal.sh 121 → 122` | **PASSED 22:46:07Z.** 1116576 refuses 122, so a rollback means a database restore. The candidate controller (all readiness checks, including `reaper`), Operator API and dashboard were ready on 122, with the ledger unchanged. The rollback restored 121 and 1116576 was ready again. Production PIDs unchanged |
| Founder `upgrade-rehearsal 7c194b8` and `revision-rehearsal` | **REFUSED, not run** (see below) |
| Recovery rehearsal (`recovery-rehearsal.sh`, sha `3e5474e0…`; log `b20da8b1…`) | **PASSED.** See below |
| Real-process synthetic test (local) | **PASSED 2/2.** It now also proves the start-while-dead case. See below |
| HQ | 0.27.0 is unchanged. The candidate's `fleet-ui-deploy.sh --check` reports "reuse, already served (no switch, no restart); nothing changed" |
| Production before / after (22:42:10Z / ~23:00Z) | **Identical:** schema 121; ledger head 1179 `1e64694cbc6821e781a…` (verify true); agents, founder cognition, state, units, unit files, PIDs, packages, tools and settings; events 3,018 → 3,018 with the same permanent-history digest; `current` 1116576. Both founder units are `failed` / exit 3 with 0 restarts. Inference is off and the four flags are false. Only `automaton_fleet` exists, because every copy was dropped. The baseline full dump `e1c7086b…` has 5,475 TOC entries |

**The founder rehearsals refused correctly.** `fleet-founders` refuses any real-runtime rehearsal while founder units or
state that are not living production founders exist on the host. The two dead founders' failed units and Agent-1's
state directory are exactly that. Getting past the refusal would mean touching the dead agents' units or state, so it was
not attempted.

These rehearsals exercise a founder **runtime upgrade**. c448d98 changes no founder runtime, so they are not a
precondition for installing it. Once the founders are living again, the guard allows them, and they should run before
any future founder upgrade.

(A side finding: the 1116576 baseline script printed "toc 0 lines" because `postgres` cannot open a 0600 file in a 0700
directory by path. The dumps were valid. The script now reads the dump through stdin.)

### The recovery sequence, established by evidence

1. **A founder process cannot be started first.** The founder runtime of both 7c194b8 and b60e262 asks the controller
   whether it is accepted as living before its first heartbeat.
   - Against a dead record it throws `FounderRejectedError`, which exits with **code 3**.
   - The founder unit has `RestartPreventExitStatus=3 4`, so systemd never restarts it. That is exactly what production
     shows now: `failed`, exit 3, 0 restarts.
   - The real-process test proves this on both runtimes. A start against the dead record leaves the process exited with
     code 3, the status still `dead` and `last_heartbeat` unchanged.
   - On the production copy, a heartbeat for the dead identity returns `dead`.
2. **Reinstate first**, with `founder-reinstate`.
3. **Then start** the units with `systemctl start`.
4. **Each founder becomes active by its own heartbeat and a passed challenge.** The hold ends at that moment.

The hold protects the gap between reinstating and starting, and any slow start.

**Two kinds of proof:**

- **Real processes, synthetic identities:** `src/__tests__/fleet/fleet-v122-recovery-real-founders.test.ts`, 2/2, local.
  - It runs real founder runtimes from git-archived 7c194b8 and b60e262 trees against the candidate controller and its
    real reaper.
  - The sequence is: unresponsive → own heartbeat; a 9 s outage ridden out; death; **start while dead → exit 3**;
    reinstatement; start → heartbeat → challenge → active.
  - The identity, credential and state files are identical, there are 0 model turns and the agent stays paused.
- **Registry level, the copied production identities** (`recovery-rehearsal.sh` on a fresh production dump with the
  release's own commands): the founder processes' calls (heartbeat, challenge) were made with the release's built store.
  No production state file or credential file was used, and no founder process ran.

**Recovery rehearsal on the production copy** (dump `3f4d47ea…`, the c448d98 release's own `cli.js`):

| # | What | Result |
|---|---|---|
| 0 | Copy restored and migrated with the release's `migrate` | Schema 121 → 122. Production timings: unresponsive 120 s, dead 600 s, termination grace 480 s, health grace 300 s |
| 1 | Before reinstatement | Both `dead` with credentials revoked. A heartbeat returns `dead` |
| 2 | `founder-reinstate "INCIDENT 2026-10-27 controller outage" A1,A2 <1179> 60` | `ok`. Both `unresponsive` with **holds of 60 min**. Identity unchanged, 0 credentials revoked, paused, policy disabled |
| 3 | The hold protects (no process yet; unresponsive 30 min, heartbeats 2 h old, grace window long past) | Both still `unresponsive` after the reaper |
| 4 | Agent-1 verifies | Heartbeat → `unresponsive`; challenge `{"ok":true}` → **active**. **The hold cleared at active** |
| 5 | **Agent-2 fails verification**; the fallback is applied **before its hold ends**: `set-timeouts dead=86400`, `lifecycle-policy terminationGrace=86400` | Both audited (`timeouts_set`, `lifecycle_policy_set`). Then `founder-hold-end` (the release command; `lifecycle_hold_ended`) and 2 h simulated past the hold's end: **Agent-2 is still `unresponsive`, alive**. **Control:** the same instant at production timings, inside a transaction that was rolled back, gives **Agent-2 `dead`**. So the fallback is what prevents the death |
| 6 | Agent-2 recovers later, inside the window | Heartbeat → challenge `{"ok":true}` → **active**, hold none |
| 7 | Timings restored, once both are active | 120 / 600 / 480 / 300, identical to before. Both still active |
| 8 | The incident's downtime (106 s reaper gap, heartbeats 126 s old) | Both stay active |
| 9 | Books and history | Reversals 1180 → 1179, 1181 → 1177, 1182 → 1178; the originals 1177–1179 and both `agent_died` events are kept. Unallocated 0, unbacked_estates 0, living 2/2, paused, cognition-log rows unchanged (1,091 → 1,091), ledger verifies. Live head unchanged; live agents dead; live timings 600 / 480 |

### The containment fallback (concrete; existing commands only; nothing new built)

If an agent has not passed its challenge **15 minutes** after its unit started, or its unit fails earlier, the recovery
script immediately does the following (still **45 min before** the 60-min hold ends):

1. It raises the two lifecycle death timings to **24 h**: `fleet:admin set-timeouts dead=86400` and
   `fleet:admin lifecycle-policy terminationGrace=86400`.
   - These are the existing, owner-only, audited commands.
   - The v122 reaper counts both timings **from the hold's end**, so after the hold the agent cannot be killed for
     24 h.
   - They are the only two automatic death paths for an unresponsive founder. The others (parent-reported terminal,
     orphan slot, economic death) do not apply to these agents. The control in step 5 proves the effect.
2. It **stops the failing agent's unit** so it cannot loop.
3. It keeps its journal, its registry row and its challenges as evidence.
4. The agent stays **alive, unresponsive, paused, with no inference, and spending blocked** by the tripped breaker.
   Agents that already verified stay active. The settings are fleet-wide, but the registry holds only these two agents
   (cap 2).
5. Next, the owner diagnoses and fixes the agent, then runs `systemctl start`. The agent becomes active by heartbeat and
   challenge. `recover.sh restore-timings` then returns 600 / 480; it refuses while any agent is not active, because an
   unresponsive agent past the normal grace would die at once.
6. If more time is needed, the same two commands can be re-applied before the window ends. The registry bounds each
   setting at 7 days, and every change is audited.

This is bounded maintenance protection with no new code. The proposed `lifecycle_hold_extend` (not built) would scope
the same protection to one agent, but it is not needed for this recovery.

### Group B: the exact installation and recovery package (PREPARED; NOT RUN; needs the owner's approval)

**Part 1: install** (`install-c448d98.sh`, **sha256 `a788fd7dc432e6cf55bf9b8f9ba4cd5813aa8aa1347db1379101448bd02fd071`**,
staged identically as `~/rlc139/install.sh`; run with `bash ~/rlc139/install.sh`)

- **Pins:**
  - commit `c448d98a1c32c63af89288758240fc5787f9f9d6`;
  - build `48c0015ed443e23e835eed697ff5bc01275509d23fd13783a21f2422ad7c5725`;
  - lockfile `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1`;
  - UI 0.27.0 (`~/rlc138/ui-0.27.0-1116576.tgz`, `bccb6e66…`), **reused, not switched**.
- **Gates, checked before any change** (all dry-run read-only against production now: PASS):
  - pins;
  - both rehearsals passed and are under 24 h old (**before 22:45Z on 28 Oct**);
  - release present;
  - schema 121 on 1116576;
  - **the incident state:** both dead by `health_timeout`, units `failed` / 3, credentials revoked, wallets frozen,
    estates settled;
  - **containment:** breaker tripped, only the canary hold open at 10,023,033,480 µ¢, Fleet Control budget unset, policy
    off, provider `none`;
  - timings 120 / 600 / 480 / 300;
  - incident evidence `SHA256SUMS` verifies (9 / 9);
  - permissions closed, flags false, founder unit template identical;
  - `FLEET_ROLLOUT_AUTO_RESTORE` unset;
  - a fresh full dump (TOC checked; kept, never restored).
- **Change:** `fleet-release.sh … 121 122 0.27.0 …`.
  - Backend cutover: dump, migrate 122, reconcile, approve, restart the controller-side units.
  - With both agents dead, a controller outage cannot cost a life.
- **Verification:**
  - controller ready;
  - agents **still dead and untouched**;
  - containment unchanged;
  - **no recovery event and no hold**;
  - timings unchanged;
  - ledger head, credit, payable, tiers and unallocated unchanged;
  - v116–v121 checks;
  - **v122:** both owner functions present, the reaper with the hold and the 45 s resume gap, `unbacked_estates` at 0,
    the four new events routed;
  - UI 0.27.0 served, unit files unchanged, ledger verifies.
- **On failure:** no restore. The controller-side units stop and the owner decides.

**Part 2: recovery** (`recover-c448d98.sh`, **sha256 `454ec43e2a1d9e7c273944bf8050cdcd093fde28961a8e0049246c06c8a7d5b9`**,
staged as `~/rlc139/recover.sh`; run with `bash ~/rlc139/recover.sh` **only after Part 1 completed**)

- **Gates:**
  - c448d98 / build 48c0015e on 122, controller ready;
  - registry exactly the two dead founders, with the incident's `health_timeout` deaths;
  - no earlier reinstatement;
  - units `failed` / 3 and state directories present;
  - journal 1179 = the acquisition cost `3cb79f23-c4fa-4aaa-a090-a5dfe1a2c0fd`;
  - timings production;
  - containment intact;
  - evidence verifies;
  - cap 2 with 0 living;
  - a fresh full dump (kept, never restored).
- **Steps:**
  1. `founder-reinstate "INCIDENT 2026-10-27 controller outage" 01M3F50SH7PNX2E3GST13J52AS,01M4C4NXT786Q4E9725N5A15KV
     3cb79f23-c4fa-4aaa-a090-a5dfe1a2c0fd 60`. It is one atomic transaction, and a refusal changes nothing. Then
     checks: both unresponsive, holds ~60 min, credentials live, estates reverted, **exactly** reversals 1180 > 1179,
     1181 > 1177, 1182 > 1178, originals and deaths kept, unallocated 0, unbacked 0, ledger verifies, containment
     unchanged. These 13 checks ran verbatim on a disposable copy: 0 failed.
  2. `sudo systemctl start` both founder units.
  3. Watch for up to 15 min: heartbeat → challenge → active.
  4. The fallback above, if needed (exit 3, "RECOVERY CONTAINED, NOT COMPLETE").
  5. Verification: both active, holds ended at active, latest challenge passed, no cognition turn, ledger unchanged since
     step 1, timings production, containment unchanged.
- **Not included:** ending containment (breaker, Fleet Control budget, canary hold), inference, resume, key rotation
  (operator key R4), funding, the R3 inference-profile preflight, any founder runtime change, the hold extension.
- **After recovery** (separate, when you decide): the founder upgrade and revision rehearsals become runnable. Stage 1
  re-planning needs `FLEET_INFERENCE_PROFILE` (R3), which is still absent from `service.env`, and the operator key (R4).

## Group B, 28 Oct 10:48–10:57Z: installation STOPPED at its own gate (script defect); production unchanged; recovery not reached

Owner approval (28 Oct): install `install.sh` = `a788fd7d…`, then — only after it verifies — `recover.sh` = `454ec43e…`, with
preconditions: the watcher survives SSH/session loss, its failure handling applies the fallback if a unit fails or
verification times out, and the fallback commands work through the owner CLI without the expired operator bridge. Push of
cebfbf5 (no force) approved after checking its contents.

| Item | Result |
|---|---|
| Hashes on the VPS | install.sh `a788fd7d…`, recover.sh `454ec43e…`: both matched |
| Push cebfbf5 | contents checked (the record, both scripts, the start-while-dead test addition plus one whitespace change `const r =(`; secret scan clean); `c448d98..cebfbf5` fast-forward, no force |
| **Installation (a788fd7d)** | **refused at gate line 80, `UISHA: unbound variable`, exit 1, before the backup and before `fleet-release.sh`.** Cause: on line 25 the `UISHA=` assignment sat after the `#` of a comment. The read-only gate dry-run of 27 Oct used a separate script (`gate-dryrun.sh`) that defined its own values, so it did not exercise this line. Production after: release 1116576, schema 121, nothing written. |
| Corrected installer | `install-c448d98.sh` = **`0a94b3d302a71eceeaf24526ae24c9955588d4c039672bc07087e596a14842b3`**. The only change is that `UISHA=…` now comes before the comment. A scan of both scripts finds no variable used without an assignment (it would have caught this one). Its step-0 gates ran for real against production (gates-only copy cut before the backup, snapshot files in a temp directory): **ALL STEP-0 GATES PASSED** at 10:56:22Z. Staged as `~/rlc139/install.sh`; the failed one is kept as `install-a788fd7d-failed-gate.sh` (+ .log/.console/.exit). **Not run: the hash differs from the approved one.** |
| Founder upgrade/revision rehearsals | stay recorded as NOT RUN (the guard refused); exception accepted by the owner; guard not bypassed |

Recovery preconditions (checked before any reinstatement; recovery itself not reached):

- **Survives SSH loss:** the launch is `setsid nohup … < /dev/null` (own session, no tty). logind `KillUserProcesses` is at the
  default (no). Test: a detached process outlived its SSH session being cut server-side (its sshd killed; the client got
  "closed by remote host"), and finished; `sudo -v` and `sudo systemctl` worked without a tty (NOPASSWD). Founder units are
  `Type=exec` (the start returns at exec; TimeoutStartSec 90 s).
- **Fallback through the owner CLI, no operator bridge:** the CLI's set-timeouts / lifecycle-policy go straight to PostgreSQL with
  `FLEET_ADMIN_DATABASE_URL` from `/etc/automaton-fleet/admin.env` (root:automaton-fleet-admin 0640; ubuntu is in the group),
  actor `operator:ubuntu`; no Operator API, no operator key. Read-only on production: `lifecycle-policy` (no arguments) prints
  the policy as ubuntu. Executed on a disposable copy (`fleet_fallback_check`, the v121 rollout dump migrated to 122 by the c448d98
  dist CLI) with the production admin credential, only the database name changed: `set-timeouts dead=86400` rc 0 and
  `lifecycle-policy terminationGrace=86400` rc 0 → `120 86400 86400 300` (exactly what recover.sh step 4 checks); events
  `timeouts_set` and `lifecycle_policy_set` by `operator:ubuntu`; the restore path → `120 600 480 300`. The copy was dropped,
  production unchanged.
- **Failure handling:** recover.sh breaks its watch loop when either unit's ActiveState is `failed` (exit 3 is never restarted)
  or at 900 s (a unit crash-looping with another exit code is `activating`, so it reaches the 900 s branch), then applies the
  fallback and stops the failing unit(s). **Gap found:** if `founder-reinstate` succeeds but one of the seven checks after it
  fails, `die()` exits before the units start and without the fallback, and the agents would die about 70 minutes later unless
  someone acted. The pinned script is not changed. Instead, **`recover-run-c448d98.sh`
  (`f6a8d7e13918588ccdade37a857ca1886d19095c7bd5dd8a3b99717d81126a12`)** is the detached launcher. It checks recover.sh's hash,
  runs it, and if it ends other than 0 (COMPLETE) or 3 (CONTAINED) while an agent is reinstated but not active, it applies the
  same two owner-authorised timing commands. It never reinstates, starts, stops or posts anything. Tested on a disposable copy
  (`fleet_guard_check`) with a stub that ran the release's `founder-reinstate` and then exited 1: both agents were unresponsive
  with holds, the supervisor applied `120 86400 86400 300`, and production was unchanged.
- Gates of recover.sh that can be read now all hold: registry = both dead; the two `agent_died` health_timeout events
  (ids 11469, 11472); no `agent_reinstated`; both state directories present; J1179 correct; cap `2 0`; evidence verifies;
  `node`/`curl` on PATH.
- Side observation: `fleet_events` is 2810 (3018 on 27 Oct). The daily `svc_event_retention` at 07:00Z expired 208 temporary
  events older than 7 days (only types with a retention period). Every incident event (11458–11481) is present; permanent
  events never expire.

**Proposed launch (on approval of `0a94b3d3…`):** `setsid nohup bash -c 'bash ~/rlc139/install.sh; echo EXIT=$? > ~/rlc139/install.exit' < /dev/null > ~/rlc139/install.console 2>&1 &`,
then, only on `INSTALL COMPLETE` with EXIT=0, `setsid nohup bash ~/rlc139/recover-run.sh < /dev/null > /dev/null 2>&1 &`
(logs: recover-guard.log, recover.console, recover.log, recover-evidence/). Rehearsal deadline 28 Oct 22:45Z.

## Group B executed 28 Oct 11:11–11:15Z: c448d98 INSTALLED; Agent-1 and Agent-2 RECOVERED (active, paused); no fallback needed

- Approvals amended (owner): installer `0a94b3d3…` (diff from `a788fd7d…`: line 25 only, the UISHA assignment), supervisor
  `recover-run.sh` `f6a8d7e1…` invoking the unchanged `recover.sh` `454ec43e…`; all three full hashes verified immediately before
  each launch. d6bc595 pushed (3 files as described, secret scan clean; `cebfbf5..d6bc595`, no force).
- **Install** (detached, 11:11:49Z): pre-install backup `baseline-pre-install-c448d98-20261028T111150Z` (5475 entries); controller
  outage 11:12:51–11:13:37Z (46 s; both agents were dead, so no lives were at risk); reconciliation OK (2810 events preserved);
  `RELEASE c448d98 DEPLOYED` 11:13:45Z, schema 122; all post-install checks passed; **INSTALL COMPLETE, EXIT=0** at 11:13:50Z.
- **Recovery** (supervisor detached, 11:14:09Z): pre-recovery backup `baseline-pre-recovery-c448d98-20261028T111411Z` (5486
  entries) → `founder-reinstate` at 11:14:14Z (both unresponsive, holds to 12:14:14Z, reversals 1180>1179, 1181>1177, 1182>1178,
  all seven step-1 checks passed) → units started at 11:14:16Z → Agent-2 heartbeat and challenge passed at 11:14:17Z, Agent-1 at
  11:14:18Z, `agent_recovered via health_challenge`, holds ended at active. Step 5 confirmed both holds ended, the latest
  challenges passed, containment intact, and no cognition turn. **Then a false stop:** "the ledger moved after the
  reinstatement". Script defect: `H0` was taken at step 0, BEFORE the reinstatement, so the three expected reversals (head
  1179→1182, logged by the script right after step 1) tripped the check. The head stayed at 1182 from step 1 onward, so
  the ledger did not move after the reinstatement. recover.sh exited 1. The supervisor found nothing exposed (both active)
  and correctly applied no fallback. The one remaining step-5 check (timings) was verified read-only: production values.
- **Final state** (read-only, ~11:16Z):
  - Registry: both `active`, runtimes 7c194b8 / b60e262 (verified), no holds; cap 2, living 2.
  - Units: active/running, PIDs 2241482 (Agent-1) / 2241491 (Agent-2), started 11:14:16Z, NRestarts 0.
  - Credentials: same token hashes, not revoked. Challenges passed at 11:14:17/18Z and again at 11:15:18Z.
  - Ledger: reversals 1180–1182 posted; originals 1177–1179 and death events 11469/11472 kept; estates `reverted`. Head 1182
    `08881fec3c34386f`, verify ok, 1123 journals, 0 unbalanced.
  - Balances (from SQL): owner payable 1081 (was 1267; −186 = `ai_cost_unwound` amountMinor 186), unallocated 0,
    unbacked_estates 0, Agent-1 cash 8943, Agent-2 cash 10000; credit 11523033480 µ¢ (unchanged).
  - Lifecycle timings: `120 600 480 300` (production; no fallback applied).
  - Containment: breaker tripped, Fleet Control budget unset, canary hold 10023033480 kept, policy disabled, provider none,
    both paused, sales closed, 0 live refund authorities; the four safety flags false.
- **State checksums** vs the incident snapshot tarballs (hashes only):
  - Agent-1: 1087 of 1089 files identical; Agent-2: 13 of 15.
  - For both, the only changed files are `runtime-instance.json` and `runtime-report.json` (rewritten by the new process at
    start); `founder.json` and `fleet-credentials.json` are identical.
- Follow-up: fix the `H0` placement in recover-c448d98.sh if the script is ever reused (the record keeps it as run). The
  founder upgrade/revision rehearsals are now runnable (living founders) and still recorded as not run. R3/R4 remain open.

## Incident close-out and activation-retry package (28 Oct, prepared locally; nothing applied to production)

Under the owner's close-out instruction: no production edit, key rotation, paid call, agent resume or database restore. Every
production contact below was read-only, or ran on a disposable copy that was then dropped.

### 1. Recovery result, as it stands in the record

**Recovery SUCCEEDED; the executed script `recover.sh` (454ec43e) EXITED 1.** Both statements stay true.

- Success rests on the explicit checks after the run (section "Group B executed"):
  - both agents `active`, paused, on 7c194b8 / b60e262;
  - own heartbeats; challenges passed at 11:14:17/18Z and every minute after;
  - holds ended at active; credentials unchanged;
  - identity files identical to the incident snapshot;
  - reversals 1180–1182 posted, originals and death events kept, ledger verifies (head 1182), timings at production values;
  - containment unchanged.
- The exit 1 was the script's own false ledger check. The supervisor correctly applied no fallback.
- The executed script stays as it ran: `cebfbf5:docs/evaluations/launch-candidate/recover-c448d98.sh`, and `~/rlc139/recover.sh`
  on the VPS.
- Its logs are copied into `evidence/recovery-20261028/`, all matching their VPS hashes (`SHA256SUMS.vps`), with no secret
  patterns: `recover.console`, `recover.log`, `recover-guard.log`, `reinstate.json`, `install.console`, `install.exit`.

### 2. Recovery script corrected and rehearsed (production reinstatement not re-run)

`recover-c448d98.sh` is now **`23eb1086b3f49d65cd28c87424ba10a308d1e2e85bef42b81901f82b138f9260`**, with two corrections:

- **(a) Ledger check.** The baseline `H1` is taken after the reinstatement and its checks, so the expected reversals
  1180–1182 no longer trip it.
- **(b) Fallback path (found by the new rehearsal).** On 28 Oct the watch loop stopped at the first unit failure. Any agent
  still between heartbeat and challenge was then counted as failing and its healthy unit stopped. Now:
  - one failure applies the fallback timings at once (idempotent `apply_fallback`);
  - the watch continues until every agent is active or failed, or the checkpoint passes;
  - only agents that failed or never became active are stopped.

  On 28 Oct both agents succeeded, so this path was never reached.

**Harness:** `rehearse-recover.sh` (`f787807d…`).
- It runs a script version against a disposable copy of `baseline-pre-recovery-c448d98-20261028T111411Z` (production one
  second before the reinstatement), using the release's own `founder-reinstate`.
- Systemd is replaced by stubs. A started stand-in founder heartbeats and answers its challenge through the c448d98
  `PgFleetStore`. A failing one leaves its unit `failed/3`. A hanging one sits `active` with no heartbeat.
- The harness refuses to run if any production call survives its substitutions.
- Production was compared before and after every scenario: unchanged.

| Script | Scenario | Result |
|---|---|---|
| executed 454ec43e | both start | **rc 1, "the ledger moved after the reinstatement"**: reproduces 28 Oct; both agents active |
| corrected 23eb1086 | both start | **rc 0, RECOVERY COMPLETE**; head 1182; timings 120 600 480 300 |
| corrected | Agent-2 unit fails at once | fallback timings at 11:46:18Z, the moment it failed; **Agent-1 kept verifying and is active, its unit running**; only Agent-2 stopped; rc 3; `120 86400 86400 300` |
| corrected | both fail | timings at the first failure; both alive (unresponsive, holds); both units stopped; rc 3 |
| corrected | Agent-2 runs but never heartbeats (checkpoint shortened to 40 s) | fallback at the checkpoint; only Agent-2 stopped; Agent-1 active; rc 3 |

Log: `evidence/recovery-20261028/rehearse-recover.log`.

### 3. Startup preflight (R3): `scripts/fleet-controller-preflight.mjs` (`2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628`)

**What it does:** it runs the **installed release's own startup validators** against a candidate configuration, without
starting the controller: no listener, no reaper, no writes. These are the same calls `startFleetServiceFromEnv` makes before
it constructs the service:

- the service user;
- no admin credential;
- the service and agent database URLs;
- TLS (certificate, key, hostname, expiry);
- the listen addresses;
- the runtime pins;
- **the inference profile and cognition provider, including the key file's owner and mode**;
- the research fetcher;
- registry health;
- the service and agent roles are restricted;
- the privilege audit;
- the pins match the registry's approved runtime.

**How it matches what the controller loads:**
- It reads the unit's own `Environment=` lines.
- It reads `LoadCredential=` sources from `systemctl cat`, because `systemctl show` prints them as `[unprintable]`. It checks
  them as systemd requires: regular file, one link, root, 0600.
- It builds the environment with the release's `loadServiceEnv` and maps `/run/credentials/<unit>/NAME` to each source.
- Only check names, PASS/FAIL and the release's own error messages are printed.

**Tests:** `src/__tests__/fleet/controller-preflight.test.ts`, **7/7**:
- the 27 Oct configuration fails with the controller's own error;
- the same configuration with `cloud_allowed` passes;
- the contained configuration passes;
- a loose key file fails;
- a loose `service.env` and an invalid profile fail;
- no secret appears in the output;
- **drift guard:** every validator `startFleetServiceFromEnv` calls before `new FleetService` must appear in the preflight,
  and the number of `throw` sites in that span is pinned at 11.

**Production, read-only** (`evidence/preflight-20261028/preflight-production.log`; run as root with the installed c448d98 `dist`):

| Configuration | Result |
|---|---|
| current `service.env` (provider none) | **PREFLIGHT PASSED, 16/16** (TLS remote on, schema 122, roles restricted, privileges clean, pins = approved c448d98) |
| `service.env.failed-stage1-20261027T2114Z` (the file that crash-looped the controller) | **FAILED, 1 of 16:** "FLEET_COGNITION_PROVIDER=anthropic is a cloud provider: the inference profile is local_only (set FLEET_INFERENCE_PROFILE=cloud_allowed explicitly to permit it)." — **it would have stopped the 27 Oct restart** |
| retry candidate (current + provider anthropic + key file + profile; temporary root 0600 file) | **PREFLIGHT PASSED, 16/16**, `profile cloud_allowed, provider AnthropicProvider` |

**Limits:**
- Failures after the service is constructed are not checked: binding the ports, the FX refresher, a crash at runtime.
- The bounded restart with automatic rollback (section 6, step 4) covers those.
- The preflight needs no new release: it loads the installed `dist`.

### 4. Inference profile: C2 `config-inference-profile.sh` (`6a5e0dea3ea30794775b2a19253ffe75e249aed2bd4a3c99b2df6d920474e2e2`)

- **What it does:** adds exactly `FLEET_INFERENCE_PROFILE=cloud_allowed` to `service.env`. The provider stays `none`, and
  there is no restart and no inference.
- **Facts it relies on:**
  - the registry's own profile is already `cloud_allowed` (v112, 24 Oct, "kept as configured");
  - the 27 Oct Stage 1 file differed from today's only in provider `anthropic` and the key-file line; every other line is
    identical.
- **Gates:** the preflight's hash, release c448d98, the registry profile, provider none, the policy disabled, and the current
  file passing the preflight (it is the rollback).
- **Sequence:** backup `service.env.pre-inference-profile-<ts>` → install atomically (root 0600) → **preflight of the LIVE
  file**, restoring automatically if it fails → controller PID unchanged.
- **Rollback:** `sudo cp -p <backup> service.env`. No restart is needed while the controller has not restarted.
- **`--check` (read-only, 11:52Z):** **C2 CHECK PASSED.** The current file and the would-be file both pass the preflight
  16/16, the new one as `profile cloud_allowed, provider none`.

### 5. Operator key rotation (R4): the procedure (C1)

All three operator keys are expired (read-only registry query):

| Principal | Use | Key | Expired |
|---|---|---|---|
| `claude-operator` `op_01M3CKG338G2KDJ19FYEKT2T40` | **this Claude Code's `fleet-operator` MCP server** (signed Operator API) | `dbaf93c5…` | 25 Oct 15:38Z (the incident's `KEY_EXPIRED`) |
| `bridge-claude` `op_01M3AX56W25JNMQCTBM8HYH474` | the older CLI bridge (same machine) | `ec4f0698…` | 24 Oct 23:49Z |
| `bridge-chatgpt` `op_01M3B18TXVP33S6NQC909DXD57` | the ChatGPT adapter on the VPS | `fe22d91c…` | 25 Oct 01:00Z |

**Context:**
- The **recovery path never depended on these keys.** The owner CLI, run as `ubuntu` with the admin credential, needs no
  operator key, and it is what recovered the agents.
- The keys matter for observation through the MCP, and for the Operator API's controlled actions.

**C1 — rotate `claude-operator`** with the release's own rotation tooling (`src/fleet/bridge/keys.ts`, identical in the MCP's
checkout). Every step refuses to run out of order. Set `CFG=~/.config/automaton-fleet/operator/claude-operator.json`.

| # | Where | Command | Proof (secret-safe) |
|---|---|---|---|
| 0 | dev VM | `cp -p $CFG $CFG.pre-rotation-<ts>`; `pnpm fleet:bridge --config $CFG key status` | expired, `dbaf93c5…`, no pending key (read 28 Oct) |
| 1 | dev VM | `pnpm fleet:bridge --config $CFG key rotate-prepare --expires-days 30` | a new private key is generated **on the dev VM** (0600, exclusive create; it never leaves the machine). It prints the key id, the **public** key and the VPS command |
| 2 | VPS (owner CLI as ubuntu) | `cli operator-add-key op_01M3CKG338G2KDJ19FYEKT2T40 --public-key <public key> --expires-days 30` | `operator_key_added` event; a registry row with the new key id and an expiry about 30 days out |
| 3 | dev VM | `… key rotate-verify` | a signed `whoami` with the **pending** key must answer with that key id and principal; records the server's expiry |
| 4 | dev VM | `… key rotate-switch` | the pending key becomes current; prints the revoke command |
| 5 | VPS | `cli operator-revoke-key dbaf93c527972eed4dfc449ce5a8cac5 rotated to <new id>` | the old key is revoked |
| 6 | dev VM | `… key rotate-finish` | the old key must be **rejected** (AUTH_FAILED / KEY_EXPIRED) and the new one must work; only then is the old private key file deleted |
| 7 | Claude Code | reconnect the `fleet-operator` MCP (`/mcp`); `fleet_whoami`, `fleet_lifecycle_health` (read-only) | `claude-operator` with the new key id; `key status --remote` shows about 30 days |

- **What is never shown:** private keys, signatures and nonces (the tooling never prints them). The only things that leave
  the dev VM are the public key and the key id. Key files are checked to be 0600.
- **Rollback:**
  - *Before step 4:* `cli operator-revoke-key <new id> aborted`, then restore `$CFG.pre-rotation-<ts>` and remove the
    pending key file. This returns to today's state.
  - *After step 4:* the same, because the old key cannot be revived (it is expired).
  - Neither case affects the owner CLI, which stays the recovery path.
- **Monitoring (the incident's R4):** `stage1-retry-inference-on.sh` refuses to run unless `claude-operator` has an unrevoked
  key valid for 7 days or more.
- **C1b (optional, your decision): revoke the two other expired keys** (`ec4f0698…`, `fe22d91c…`). They are unusable already;
  revoking them makes that explicit in the registry. The principals stay. Rotating `bridge-chatgpt` instead uses
  `scripts/fleet-chatgpt-setup.sh`, which is a separate decision.

### 6. The refused founder upgrade/revision rehearsals: no added coverage needed now

**What they test:**
- **Upgrade rehearsal:** moving a living founder between runtime commits (upgrade, `rollback-runtime`, fail-closed refusals,
  routed cognition on the target).
- **Revision rehearsal:** the customer revision → delivery path in a real founder unit.

They last passed on the 7c194b8 controller (26 Oct: 27/27 and 19/19).

**What changed since then:**
- `git diff 7c194b8 c448d98` touches **no file** in `src/fleet/cognition`, `src/fleet/founder`, `src/fleet/genesis`,
  `src/fleet/service`, `src/agent`, `src/fleet/eval`, `scripts/fleet-founders.sh` or `deploy/systemd`.
- The only changes are the database schema (v121 treasury reads, v122 lifecycle/recovery), the hub's owner commands and the
  privilege lists.

**Coverage for the v122 paths:**
- the real-process test (2/2, both runtimes);
- the production recovery itself;
- 40+ minutes of live heartbeats and challenges on c448d98.

**Conclusion:**
- The Stage 1 retry changes no runtime and delivers nothing to a buyer, so neither rehearsal adds necessary coverage for it.
- **They become necessary before the next founder runtime upgrade, or any use of `rollback-runtime` on schema 122.** Their
  guard is satisfied now that both founders are alive.
- They are recorded as NOT RUN for c448d98, not run merely to complete a checklist.

### 7. Approval package: two separate approvals

**Part C: configuration and credentials (no restart, no inference, no resume, no money).** Order: C1, then C2. C1b is optional.

| Item | Exactly | Changes | Does not change |
|---|---|---|---|
| **C1** operator key | the 8-step `claude-operator` rotation above (30-day key) | one new public key in `fleet_operator_keys`; the old one revoked; the dev VM key file | the owner CLI; controller; agents; containment |
| **C1b** (optional) | `operator-revoke-key ec4f0698… expired`, `operator-revoke-key fe22d91c… expired` | two expired keys marked revoked | principals; the ChatGPT adapter (unusable either way until rotated) |
| **C2** profile | `bash ~/rlc140/config-inference-profile.sh` (`6a5e0dea…`, `--check` passed) | one line in `service.env`: `FLEET_INFERENCE_PROFILE=cloud_allowed`; backup kept | provider stays `none`; no restart; the running controller; containment |

After Part C, `stage1-retry-inference-on.sh --check` must report **CHECK PASSED** with nothing pending. Today it reports
exactly the two items C1 and C2 as pending, exit 4.

**Part D: Stage 1 retry (later; its own approval; requires Part C and a passing `--check` immediately before).**

- **Scope:** the 27 Oct Stage 1 package ("Stage 1: FINAL approval package"), Agent-1 only, with these deltas:
  - **Release** c448d98 / schema 122. Both founders are alive again (recovered), with the same identities.
  - **Steps 1–2 as approved:** Agent-1 limited to 120 calls/h; Fleet Control 30p/day (unfunded, so its reviews wait).
  - **Step 3: the hold already exists.** `canary-agent1-ceiling` is 10,023,033,480 µ¢ against a balance of 11,523,033,480.
    The gate recomputes free credit by SQL and requires exactly 1,500,000,000 µ¢ ($15) free. Nothing is re-created.
  - **Step 4: `bash ~/rlc140/stage1-retry-inference-on.sh`** (`2c2d78cc…`):
    - gates: release and schema; both founders active and paused; C1 and C2 done; the key file identical to the 23 Oct
      recovery copy; the policy exactly as recorded; breaker tripped; exactly $15 free; sales closed; production timings;
      the v122 reaper;
    - **preflight of the rollback file and of the new file**;
    - policy enabled (read back: prices 400 / 2,000 / 20 / 500, max 4,000, defaults 754p / 20);
    - `service.env` backup, then install;
    - **preflight of the LIVE file**, which restores and disables the policy if it fails;
    - **bounded restart:** ready within 30 s, otherwise automatic rollback (restore, reset-failed, restart, policy disabled),
      with the outage time reported;
    - founders re-verified active and paused within 5 minutes, founder PIDs unchanged, no cognition turn.
  - **Steps 5–8 as approved:** the guard and its timers, the files, the owner task, the resume.
  - **Deadline needs your word again.** On 27 Oct you approved option A for that run only: ENDS_AT = STARTED_AT + 24 h, and
    no automatic blocker stop. Choose option A again, or the 7-day deadline. With 7 days, the 24 h checkpoint and blocker
    stop again depend on this session (option B is still not built).
- **Containment changes Part D would make:**
  - the cognition policy enabled and provider `anthropic`;
  - Fleet Control budget 30p/day;
  - Agent-1 resumed (step 8).
- **What stays in place:**
  - **spend breaker tripped** (it gates payment orders; Stage 1 makes none);
  - **the canary credit hold** (it is the $15 ceiling);
  - sales and outward authorities closed;
  - Agent-2 paused and unchanged;
  - no funding.
- **Restart risk:**
  - On v122 the founders ride out controller outages: downtime does not count, and they recover by heartbeat and
    challenge. This was proven by the real-process test and by the 28 Oct install, a 46 s outage with both founders dead.
    With living founders, a restart is no longer lethal on the 27 Oct pattern.
  - The preflight and the bounded rollback still apply.

**Not in either part:** funding, publishing, Stage 2/3, Agent-2 changes, runtime upgrades, ending the breaker, database
restore, authentication changes.

### Files (local commit; not pushed)

| File | sha256 |
|---|---|
| `scripts/fleet-controller-preflight.mjs` | `2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628` |
| `src/__tests__/fleet/controller-preflight.test.ts` | 7/7 |
| `docs/…/recover-c448d98.sh` (corrected) | `23eb1086b3f49d65cd28c87424ba10a308d1e2e85bef42b81901f82b138f9260` |
| `docs/…/rehearse-recover.sh` | `f787807dec2b86113ab4fce7138aa01857f290161468af18d20165c7b520ad62` |
| `docs/…/config-inference-profile.sh` (C2) | `6a5e0dea3ea30794775b2a19253ffe75e249aed2bd4a3c99b2df6d920474e2e2` |
| `docs/…/stage1-retry-inference-on.sh` (D, step 4) | `2c2d78cc246c9eaaac31fb3e6db1baade8a300f4268e555df8142e6eefd287e0` |
| `docs/…/evidence/recovery-20261028/`, `evidence/preflight-20261028/` | the executed recovery's logs; the read-only preflight runs |

Staged on the VPS in `~/rlc140/` with the same hashes. Nothing there has run except the read-only `--check` modes, the
preflights and the disposable-copy rehearsals.

## Part C executed (28 Oct 12:01–12:03Z): operator key rotated, inference profile recorded; production otherwise unchanged

Pushed first: `d6bc595..73ae0b9` (50fb937 and 73ae0b9; scope as described; secret scan clean). The only pattern hits were
the preflight test's placeholder connection strings: `pw-preflight-secret`, port 1.

**C1: `claude-operator` key rotated with the release's own tooling (30 days)**

| Step | Result |
|---|---|
| Baseline, through the actual operator tool (`fleet_whoami`) | `KEY_EXPIRED` for `dbaf93c5…` (refused by the client) |
| Config backup | `claude-operator.json.pre-rotation-20261028T120109Z` (0600). It is a record, not a rollback: the old private key is deleted and the old key is revoked and expired |
| `rotate-prepare --expires-days 30` | new key `ce7e51321565092d4f9701ccda65a1a9`, generated on the dev VM, file 0600. The tooling names it `bridge-claude.20261028T120109Z.key`; that is a naming quirk, and it is `claude-operator`'s key. Only the public key and the key id were printed |
| VPS `operator-add-key` (owner CLI, `operator:ubuntu`) | registered, expires **2026-11-27T12:01:24Z** |
| `rotate-verify` (signed `whoami` through the real tunnel, pending key) | accepted |
| `rotate-switch` | current = `ce7e5132…` |
| **Actual operator tool** (`fleet_whoami`, MCP, no reconnect needed: it reloads its config on every call) | `claude-operator`, key `ce7e5132…`, expires 27 Nov; scopes as before |
| VPS `operator-revoke-key dbaf93c5… rotated to ce7e5132…` | revoked |
| **Old key rejected by the SERVER** | a signed `whoami` with the old key, sent from a temporary private config with the local expiry check removed (deleted afterwards): **`AUTH_FAILED`** "signature not accepted (unknown, revoked or expired key…)", request `3a46c5e4…` |
| `rotate-finish` | the old key rejected and the new one working → the old private key file deleted; `key status --remote`: ok, 29.9 days |
| Actual operator tool, again (`fleet_lifecycle_health`) | 2 active, 0 stale heartbeats, 0 overdue challenges, reaper current |
| Other keys | `bridge-claude` `ec4f0698…` and `bridge-chatgpt` `fe22d91c…`: **unchanged** (expired, not revoked), as instructed |

No private key material was printed or logged. Every key file stays 0600 in the 0700 operator directory. Owner-CLI access
was never touched.

**C2: `config-inference-profile.sh`**
- Its full sha256, `6a5e0dea3ea30794775b2a19253ffe75e249aed2bd4a3c99b2df6d920474e2e2`, was recorded and matched three ways:
  the reviewed copy at 73ae0b9, the pinned value, and the staged VPS copy.
- Run at 12:02:57Z: the current file passed the preflight 16/16; the new file 16/16; backup
  `service.env.pre-inference-profile-20261028T120300Z`; installed; **the LIVE file passed 16/16**.
- `service.env`'s **only** change is the added line `FLEET_INFERENCE_PROFILE=cloud_allowed`. It is still root:root 0600 with
  one link.

**Verification afterwards** (snapshots `evidence/partc-20261028/c2-before.txt` and `c2-after.txt`). **The only difference is
the profile line:**

- provider `none`; cognition policy **disabled**;
- **no controller restart:** PID 2240025, started 11:13:29Z, 0 restarts (unchanged);
- founder PIDs 2241482 / 2241491 (unchanged); **both agents active and paused**;
- ledger 1182 `08881fec…`, verifies; credit 11,523,033,480 µ¢; hold `canary-agent1-ceiling` 10,023,033,480 µ¢ open;
- breaker tripped; Fleet Control budget unset; sales closed; refund authorities 0; outward releases 0; card / identity
  autonomy off; custody activation none;
- timings 120 / 600 / 480 / 300;
- **Stage 1 step-4 read-only check: CHECK PASSED** (nothing pending; both preflights 16/16).

## Part D: final pinned package (prepared 28 Oct; NOT approved, NOT run)

**`stage1-retry.sh` (`848db128…`, full hash in the table below)** is the only command. It is staged in `~/rlc140/`. It runs
the pinned step-4 script (`2c2d78cc…`) and the pinned preflight (`2c6f6c37…`), and copies the pinned files
(`tracker-v6/`: xlsx `7793dff2…`, README `4494dff2…`). It refuses to start if any pinned hash differs.

| Mode | Does |
|---|---|
| `--check` | read-only, every gate. **Ran 12:06Z: CHECK PASSED.** Agent-1 754p / 120 per hour / paused; Agent-2 3,000p / 60 per hour / paused; policy off; budget unset; free credit exactly 1,500,000,000 µ¢; offer files are the expected two; no task, canary.conf or units left over; the step-4 check passed |
| `prepare` | **1** Agent-1 at 120 per hour (already set; read back). **2** Fleet Control 30p/day. **3** the hold is verified, not re-created. **4** the step-4 script: both preflights, policy on, `service.env`, preflight of the LIVE file, a bounded 30 s restart with automatic configuration rollback, and founders re-verified. **If step 4 fails:** the Fleet Control budget is cleared again and the script stops. **5** `canary.conf` and the release's four units installed (timers not enabled); `check --dry-run` and `end --dry-run` must write nothing. **6** files to `from-owner/tracker-v6/` (owner `fnd-…`, 0600, hashes verified). **7** the owner task. Agent-1 stays PAUSED throughout |
| `resume` | **8a** arm the end timer (drop-in `OnCalendar=` = start + **24 h**) and the hourly guard; **verify armed (next elapse = ENDS_AT) before resuming**. **8b** `founder-cognition <Agent-1> resume`. **8c** re-arm at exactly STARTED_AT (the resume timestamp) + 24 h and verify again |

**Deadline:** 24 hours after the resume, enforced by the persistent end timer, which runs the safe stop: pause, offer hold,
sales closed, budget off, and the hold released only when no reservation is open. There is no automatic blocker stop (the
24-hour form you approved on 27 Oct). The timer's calendar format was checked with `systemd-analyze` and round-trips
exactly.

**Correction to the approved task text (needs your word).** The 27 Oct text told Agent-1 to remove `tracker.zip` (10adb667)
and the workbook. **`tracker.zip` was already removed on 20 Oct.** The offer's live deliverables are
`Landlord_Compliance_Tracker.xlsx` `f45c3d00` and `README.txt` `4494dff2`. The pinned text now says "1) offer file remove:
Landlord_Compliance_Tracker.xlsx (f45c3d00…, the current deliverable). Keep README.txt …". Everything else is word-for-word as
approved.

**Rollback: two different things.**

| | What | When | Touches |
|---|---|---|---|
| **Configuration rollback** (automatic) | `service.env` restored from its backup; AI policy disabled; controller restarted on the old file | inside step 4: the live file fails the preflight, or the controller is not ready within 30 s | one root file, the policy flag, one restart. **No ledger, registry or event row is undone** |
| **Kill switch** (manual, immediate, no restart) | `cli cognition-disable`; `founder-cognition <Agent-1> pause …` | any time after step 4 | the policy and pause flags only |
| **Database restoration** | **never done by this package**, on any failure | only on your separate, explicit approval | everything after the dump; we fix forward instead |

**What Part D would change:**
- the cognition policy on and provider `anthropic` (restart);
- Fleet Control budget 30p/day;
- the canary units and timers;
- two files in Agent-1's workspace;
- one owner task;
- Agent-1 resumed.

**What stays:**
- breaker tripped (it gates payments; Stage 1 makes none);
- the $15 hold;
- sales and authorities closed;
- Agent-2 paused;
- no funding.

| File | sha256 |
|---|---|
| `stage1-retry.sh` | `848db128237722d5d7ae38f057a9ae3c6c28e8eab556e1dd065506c30259babf` |
| `stage1-retry-inference-on.sh` | `2c2d78cc246c9eaaac31fb3e6db1baade8a300f4268e555df8142e6eefd287e0` |
| `scripts/fleet-controller-preflight.mjs` | `2c6f6c37ad900b92b1d461996040facfcbfb88fbf27989797fe9e1be5594d628` |
| `canary-tracker-candidate/Landlord_Compliance_Tracker.xlsx` / `README.txt` | `7793dff2…` / `4494dff2…` |

## Stage 1 retry (28 Oct 12:10–12:36Z): activation SAFE, Agent-1 BLOCKED by a founder packet defect, contained; repair dd29a53 prepared

**Execution:**
- **Pins** verified at 12:10Z: package `848db128…`, step 4 `2c2d78cc…`, preflight `2c6f6c37…`, xlsx `7793dff2…`,
  README `4494dff2…`.
- **`--check`** passed.
- **Free credit, including in-flight reservations** (the controller's own v119 figure, balance − `fleet_provider_credit_held`):
  1,500,000,000 µ¢ = $15, 0 in flight.
- **`prepare`** (12:11:28–12:11:40Z, exit 0):
  - Agent-1 754p / 120 per hour, paused; Fleet Control 30p/day (unallocated £0, so its reservations wait); the hold verified.
  - Step 4: both preflights 16/16, policy on, `service.env` installed, live preflight 16/16.
  - **Restart ready in 2 s** (controller PID 2240025 → 2254751). Both founders re-verified active, same PIDs, 0 restarts, no
    lifecycle event; controller log `service_started` only.
  - Canary units installed and dry runs wrote nothing.
  - Files placed (0600, hashes verified). Task `a11941fe-6a1f-417b-9726-5cdc32b63e62` opened with the corrected text.
- **`resume`** (12:12:13–12:12:17Z, exit 0):
  - end timer armed and verified BEFORE the resume;
  - Agent-1 resumed at **12:12:16Z**;
  - re-armed at exactly **ENDS_AT 2026-10-29T12:12:16Z**;
  - hourly guard active.
  - `systemctl list-timers` showed a "LAST" time for the end timer; the end service never ran (no exec timestamp, no
    journal entry, no STOPPED marker).

**Blocker:**
- Agent-1 woke at 12:12:59Z.
- Every turn, one a minute (12 turns, 12:13:02–12:28:42Z), stopped **inside the founder before any model call**:
  `FLEET_TASK_PACKET_INVALID: packet too large` (`evidence/stage1-retry-20261028/agent1-mind-log-stops.jsonl`).
- One `AGENT_CANNOT_THINK` notification at 12:13Z.
- No paid call, no reservation, no charge.

**Containment (as instructed: an unchanged repeated failure → pause; kill switch):**
- Agent-1 **paused at 12:29:58Z**.
- AI policy **disabled at 12:33Z** (`cognition-disable`, no restart).
- No configuration rollback was needed: the configuration and controller are healthy. No database was touched.

**Root cause (founder runtime, both 7c194b8 and b60e262):** `renderBoundedPacket` called `renderTaskPacket` first, and that
refuses any packet over `PACKET_LIMITS.totalBytes` (16,000 bytes of JSON) before a single trimming step runs. Measured with
the release's own `buildTaskPacket` on a root-only temporary copy of Agent-1's memory and workspace (sizes only, then
deleted):
- the sections other than the task use about 11,300 bytes after the builder's own trims: facts 6,162, 13 research records
  3,825, the rest policy, objective and contract;
- so at most about 4,700 bytes were left for the task;
- on 20 Oct Agent-1 already needed reduction level 4. Today's essentials (the wake brief, notices 1,852, events 2,208, the
  owner task 1,232, and the rest) do not fit at any level;
- the trims that would make it fit (drop older evidence, then facts) were unreachable.

**Repair `dd29a53` (local, not pushed; changes `src/fleet/founder/mind.ts` and its test only):**
- A packet whose only problem is "packet too large" is now trimmed by the same lowest-value-first steps until it passes both
  limits. The task is never cut. Any other packet problem (secret-shaped text, a forbidden key) still refuses at once.
- **Tests:** `fleet-r23-cognition` **24/24**. The new case reproduces the production error with the old function (fails:
  `FLEET_TASK_PACKET_INVALID: packet too large`) and passes with the fix. Typecheck shows no errors in the changed files.
- **On the copy of Agent-1's real state**, the fixed logic fits tasks of 6,000 to 12,000 characters (evidence trimmed to 4,
  facts given way at the last level). Before, only about 4,700 bytes fitted.
- **Deploying it needs a new release** (c448d98 plus this fix; schema 122 unchanged) and `upgrade-runtime` for Agent-1. That
  is a production artifact, so it is presented for approval, not deployed. The founder-upgrade rehearsal from 7c194b8 is now
  necessary (section 6 above).

**State at 12:36Z (`evidence/stage1-retry-20261028/final-status.txt`):**
- Both agents `active`, heartbeats current, both **paused**, runtimes 7c194b8 / b60e262, founder PIDs unchanged, no lifecycle
  event since the resume.
- Policy **off** (`service.env` provider `anthropic`, profile `cloud_allowed`).
- Agent-1 model turns **0**, Agent-2 0, in flight 0; provider credit events 0; journals since the resume 0.
- Ledger **1182** verifies; unallocated 0, owner payable 1,081, Agent-1 cash 8,943.
- Credit 11,523,033,480 µ¢, held 10,023,033,480 (`canary-agent1-ceiling` open), **free 1,500,000,000**.
- Fleet Control 30p, spent 0, no reservations.
- Breaker tripped; sales closed; outward releases 0; refund authorities 0.
- Offer `d7063a0a` unchanged: status paused, files v5, the same two files, published 18 Oct as before, no new review.
- Task **open**; files in `from-owner/tracker-v6/`.
- Timers: hourly guard (next 13:00Z); **end 2026-10-29T12:12:16Z**, which runs the safe stop (pause, offer hold, sales
  closed, Fleet Control off, and the hold released only if no reservation is open).

## Repair A (28 Oct 12:55–13:40Z): dd29a53 INSTALLED, Agent-1 UPGRADED with identity preserved; resume STOPPED at a stale package pin (needs approval)

**Commits:**
- `dd29a53ee724657748a93c018734003466ff35fb`: code. The only runtime source change since c448d98 is `src/fleet/founder/mind.ts`
  `renderBoundedPacket`, plus its test.
- `fef13a76e7eda6f1536150d9170eaeeba0e9d588`: record.
- Both pushed `152d14f..fef13a7`, no force. The secret scan's only hits are the preflight test's placeholders.

**Build and rehearsals:**

| Step | Result |
|---|---|
| Build (VPS, two passes) | **build `c9035c92c5707f442e072e0b9a0d4d4104a5d557d8c6b50ff5aab8a8d6a04002`**, lockfile `1df54e35…` (unchanged); `~/rlc140/pins.txt` |
| Side-install | `/opt/automaton-fleet/releases/dd29a53…`, identity re-verified; `current` stayed c448d98 |
| Data rehearsal `fleet-rollout.sh rehearse 122 → 122` | **PASSED** 13:08:45Z; reconciliation OK (1,123 journals; 2,769 events preserved); the rollback dump restores 122 with the same head |
| Services rehearsal `fleet-upgrade-rehearsal.sh 122 → 122` | **PASSED** 13:09:32Z. Code-only rollback = re-approve c448d98, **no database restore**, every candidate-era write preserved; c448d98 ready on the unrestored data; the dump restore kept for the disaster path only |
| Founder upgrade rehearsal `upgrade-rehearsal 7c194b8` (synthetic founder, throwaway registry, fake provider) | **PASSED 27/27**: preflight changes nothing; unapproved build refused; mis-pinned target fails closed and rolls back; upgrade, rollback, re-upgrade with nothing lost; 0 failed challenges; routed cognition |
| Revision rehearsal | **PASSED 19/19** |
| Offline packet construction, candidate's compiled code, root-only copy of Agent-1's state + its real attention (`packet-check.log`) | owner task (1 line, 1,358 chars), 3 notices, events and upgrade line, plus 0–6,000 chars of extra essentials: **every packet that fits carries the task byte-identical and every owner-task line verbatim**; secret-shaped text, a forbidden key, and secret + oversize all **still refused**; the copied memory and workspace trees are **unchanged** by build and trim |

**Install** (`install-dd29a53.sh`, `f46631f8…`):
- `--check` passed: the live configuration with the candidate's validators passed 15 of 16 checks. The 16th was the expected
  "registry still approves c448d98", which the cutover itself resolves.
- Backup `baseline-pre-install-dd29a53-20261028T133707Z` (5,486 entries).
- `fleet-release.sh` **DEPLOYED** 13:39:08Z.
- **Controller-side outage 13:38:13–13:39:00Z (47 s).** Founders: same processes, both active and paused throughout, no
  lifecycle event.
- Ledger 1182 unchanged and verifies; containment unchanged; the installed release passes the preflight.
- No automatic restore (`FLEET_ROLLOUT_AUTO_RESTORE` unset).

**Agent-1 runtime upgrade** (`upgrade-agent1-resume.sh upgrade`, `f6e95401…`; the release's `upgrade-preflight`, then
`upgrade-runtime`):
- Agent-1 moved 7c194b8 → **dd29a53** (build `c9035c92…`). New process 2270377 (was 2241482). Heartbeat, then 1 challenge
  passed in 1.4 s; status `active`; still paused.
- **Preservation proven (hashes, before = after):**
  - agent id, creation time and wallet hash;
  - credential `4297d562…`, not revoked;
  - **memory tree `56fbc538ed518a0f`**, **workspace tree `bb81969372062838`**;
  - `founder.json` `d8a8beb4…`, `fleet-credentials.json` `f25654ba…`.
- **Agent-2 unchanged:** b60e262, PID 2241491, paused, 3,000p / 60 per hour.

**Resume: STOPPED at a gate, safely (13:39:55Z).**
- The policy was enabled with its read-back correct. Then the pinned `stage1-retry.sh` (`848db128…`) refused: "not c448d98 on
  schema 122".
- Its gate hardcodes `C=c448d98…`, which the approved install has now replaced. **The script disabled the policy again;
  Agent-1 stayed paused.** Nothing else changed.
- The old deadline (29 Oct 12:12:16Z) and the hourly guard remain armed.
- **Proposed correction (needs approval; not run):**
  - **`stage1-retry-dd29a53.sh` = `ac1a28c8f6bdfd5e13bf25f362bcfac90262c4f585baf961c41f942c03bd706f`.** Its diff from the
    approved package is line 19 only (`C=` → dd29a53). Its read-only common gates pass.
  - **`upgrade-agent1-resume-v2.sh` = `6f82c3fc86fea5210cace9f188d9a6f62589d462f5d7452407623e69e46d7f56`.** Its diff is line
    12 only (pointing at the corrected package). `--check` passed.
  - In `resume` mode the pin is used only in that one gate.

Evidence: `evidence/repair-a-20261028/`.
