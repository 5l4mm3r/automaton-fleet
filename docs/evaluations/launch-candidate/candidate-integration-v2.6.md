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
