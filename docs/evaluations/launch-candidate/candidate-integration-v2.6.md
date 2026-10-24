# Candidate fleet/integration-v2.6 (24 Oct 2026): Anthropic reasoning restored, local-run fixes kept

**Owner instruction, 24 Oct 2026:** resume the original arrangement: the VM for development, the existing VPS for unattended
runtime, the Anthropic API for reasoning (the owner's Max-included API credits), and Fleet's library and local tools for
storage and execution. No subscription-authentication adapter, no further Qwen-specific launch work. This record covers
local integration and preparation only. Nothing has been pushed, deployed, restored, or paid for.

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

## The `resolved:true` correction bypass: proposed repair (for approval; not implemented)

**Status: OPEN.** v113 (desktop) makes byte-identical resends answer nothing, but keeps an agent message with
`resolved:true` as a resolution, so the bypass remains in this combined candidate. The repair below is proposed, not built.

**Defect.** `fleet_customer_obligations` (v100, restated in v112) closes an order conversation at the later of its last sent
delivery and its last agent message with `resolves`. `revisionOwed` exists only while the conversation is open. So
`order_message {resolved:true}` after a buyer's change request erases the owed revision with no new file. `deliveryOwed`
(the first delivery) is not affected: it follows the order's status. An owner alert alone would not close this.

**Proposed behaviour.** This changes the obligation policy, so it waits for approval.
- `resolved:true` keeps one meaning: the conversation is **acknowledged**. No reply is owed, and the state is no longer
  `unanswered`.
- A **change request**, meaning a buyer message after the order's latest sent delivery, stays owed (`revisionOwed`)
  whatever `resolves` says, until one of these three things happens:
  1. **Completion evidence:** a later sent delivery of that order whose review passed. This rule exists today.
  2. **Explicit withdrawal:** the agent records `withdraw_change {orderId, quote}`, where `quote` (3–300 characters) is
     verbatim text from a buyer message on that order at or after the request. FleetController checks the quote against
     the record and refuses otherwise. Each withdrawal is a permanent event in Fleet Command with the quote, so "Thanks,
     that's perfect" and "never mind" close honestly, and the owner can see what was relied on.
  3. **The order ends:** a refund or cancellation, under today's rules.
- A buyer message after a withdrawal opens a new change request.
- The founder tool says it plainly: `resolved:true` while a change is owed answers "acknowledged; the change is still owed
  — deliver it, or withdraw_change quoting the buyer".

**Residual risk.** An agent could quote the change request itself as the withdrawal. That is visible and auditable, not
prevented. The stricter alternative, where only a buyer message after the agent's reply can withdraw, would keep a plain
"thanks!" owed until the 7-day close. With the 15-minute owed recheck, that means up to 4 wakes an hour for 7 days of paid
inference, so I don't recommend it.

**Focused regression (written with the repair):**
- PostgreSQL, the v100-obligations style:
  - (1) a change request answered `resolved:true` with no delivery: still `revisionOwed`, state acknowledged;
  - (2) then a passing redelivery clears it;
  - (3) a "Thanks!" withdrawn with a verbatim quote clears it, and the event carries the quote;
  - (4) a quote found in no qualifying buyer message is refused and the obligation stays;
  - (5) a new buyer message after a withdrawal reopens it;
  - (6) a refund clears it;
  - (7) `deliveryOwed` is unchanged by `resolves`.
- Toolbox: (8) the acknowledgement wording, and `withdraw_change` refusals.

It would be **v114**, restating v113's `fleet_customer_obligations(_all)` and order thread. It complements v113:
v113 decides which delivery can answer a request, and this repair stops `resolved:true` from answering it.

## Item 5: which organisation owns the VPS runtime key, by metadata and the Console (owner-side; not yet done)

I can't read the key: `/etc/automaton-fleet/recovery/` is root-only and this work has no sudo on the VPS. These
checks use no inference and never show the key. None of them depends on a response header.
1. **Key hint.** On the VPS (owner, sudo), print only the last four characters, which the Console also shows:
   `sudo sh -c 'f=$(ls /etc/automaton-fleet/recovery/ | head -1); tr -d "\n" < "/etc/automaton-fleet/recovery/$f" | tail -c 4; echo'`.
   If the folder holds more than one file, list it with `sudo ls -l` first and choose the key file by name.
2. **Console → Settings → API keys**, in each organisation the owner can open: the key whose hint ends in those four
   characters. Note its organisation and workspace, and its **last used** date. It should be 23 Oct 2026: the last paid runs
   ended 13:44Z and the key was put away at 14:26Z.
3. **Cross-check with recorded spend:**
   - Console → Usage/Cost for 23 Oct 2026 in that workspace should show the two engineering runs, scen-89d7c21-b1 ($5.27)
     and scen-cf86ab8-c1 ($7.213194);
   - Billing (invoice history) should show the purchase receipted as $49.55 (lot 05f4cb13).
4. **The credits.** Console → Billing of the **same** organisation should show the Max-included credit grant. If the grant
   is in another organisation, the runtime key cannot spend it. The fix is then a new key created in the grant's
   organisation and installed by the owner, never a provider change made by Fleet.

## Credit reconciliation: proposed treatment (for approval; nothing posted)

**What exists.** Provider credit is held as lots (v70–v73). The one purchased lot, 05f4cb13 (owner card, receipt $49.55
for $41.29 of credit), has 1,676,179,930 µ¢ ($16.76) remaining on Fleet's books. Lot sources are `owner` (reimbursable to
the owner) and `treasury` (a prepaid asset). Every AI charge is booked to the agent or treasury that made the call, at
provider prices; acquisition cost (tax/fees) is allocated per draw.

**Figures to read from the Console**, in the organisation confirmed in item 5. They are real figures, never estimates:
- (a) the promotional grant: its amount, the date granted, its **expiry**, and any grant identifier;
- (b) the remaining **total** balance, and how the Console splits it between promotional and purchased credit;
- (c) the order in which the provider applies promotional versus purchased credit, if shown;
- (d) usage since 23 Oct 14:26Z. Fleet made no calls in that time, so any usage there is not Fleet's.

**Proposed treatment.** It needs one migration, numbered after the v112/v113 decision.
- A new lot source, **`promotional`**:
  - `usd_purchased` = the grant amount, `usd_remaining` = the Console's remaining grant balance;
  - `expires_at` = the expiry, `external_ref` = the grant identifier;
  - acquisition cost **0** (no tax, no fee), no GBP cost.
  - Its provider-credit event is a new kind, **`grant`**, never `purchase`. It creates **no owner payable and no treasury
    asset**: nobody paid for it.
- **Lot 05f4cb13 is untouched.** The $16.76 is neither overwritten nor re-entered. If the Console's purchased remainder
  differs from $16.76, the difference is recorded as a reconciliation **observation** with both figures and the reason
  (for example, the org's own usage outside Fleet). It is posted only on the owner's word, never charged to an agent.
- **No double counting.** Fleet's available credit = the purchased lots' remainder + the promotional remainder − holds.
  The grant is entered once, from the Console figure, and usage outside Fleet (d) is never charged to an agent wallet.
- **Draw order:** the provider's actual order from (c). If the Console doesn't show it, the owner states it; Fleet does not
  assume it.
- **Agents' charges for grant-funded calls. Owner choice:**
  - **(A, recommended)** Agents pay the provider price as today. The amount drawn from the grant is booked as Fleet's
    *promotional AI credit income*, not owed to anyone, instead of the owner payable. Agent prices and budgets don't jump
    when the grant ends, and every charge is a real call at a real price.
  - **(B)** Grant-funded calls cost agents nothing. That is cheaper for agents now, but their measured costs and budgets
    understate real costs and change when the grant expires.
- **Expiry:** at the expiry, any unused grant goes to zero by an `expiry` event. There is no GBP posting and no effect on
  any agent.

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

## Tests (combined candidate; non-billable, no inference call, loopback only)

`npx tsc --noEmit` is clean. One sequential run of 26 focused files (`--no-file-parallelism`, 24 Oct):

**26 files and 296 tests passed. Runner exit status 1**, because of **1 unhandled error**. It is the known `work-continuity`
1j rejection: the test's mock provider returns no `toolCalls` (`mind.ts:1064`, `r.toolCalls.map`). It has been present
since 51a1f82, and the desktop had it too. It is recorded, not hidden, and not fixed here.

| Area | Files (tests) |
|---|---|
| Privileges / least privilege | fleet-phase4 (53), fleet-cognition-hardening (16) |
| Cognition, routing, accounting, local provider | fleet-cognition (23), -routing (26), -routing-pg (8), -accounting (11), -local (7) |
| Migrations | fleet-v112-local-inference-pg (5: profile seed on upgrade, eligibility time), fleet-f2-migration-paths-pg (2: v8/v24 → v113, clean audit) |
| Obligations (v113) | fleet-v100-obligations-pg (11) |
| Hourly limit, all three implementations | work-continuity (29: 1r 8077f6c, 1s eligibility), fleet-founder-hourly-bound (3: f9db421), fleet-client-retry-after (2), fleet-founder-retry-after-fix (7) |
| Desktop fixes | fleet-local-run2-tool-args (12), fleet-run6-replay (4), fleet-document-render (5), fleet-founder-new-work-midturn (2), fleet-founder-procedures (7), fleet-v76-founder-tools (7) |
| Inspector | fleet-qa-inspector (10), -v2 (5), -v3 (6), fleet-qa-text-off-page (4) |
| Release tooling | fleet-release-tooling (22: no automatic restore), fleet-release-script (9) |

After the run, `fleet-v76-market-fulfilment-pg` (10/10, no errors) ran once, with the one new missing-dependency case
below.

**Missing PDF dependencies cannot yield a pass.** When a library is not importable, the inspector reports a
`tool_unavailable` warn, and the file can still say `ok`. FleetController does not trust that.
`fleet_econ_review_record` (v76; v109 is the latest restatement, and v110–v113 do not touch it) sets `automated_ok` false
when any check is `tool_unavailable`, and refuses a `pass` verdict with `FLEET_REVIEW_AUTOMATED_FAILED`. Delivery and
publication need a passing review of exactly those bytes. So a check that could not run leaves the work **blocked**,
never approved. The new case records a pass on an `ok: true` report carrying only a `tool_unavailable` warn: refused.
The scenario grader's "completed" is not a review. It never read the documents (runs 3–6), and its verdict is not
evidence of fulfilment.

## Staged deployment proposal (three approval groups)

**Group 0, before any approval:** the transfer and import (below); reconcile the hourly-limit implementations and v112/v113;
rerun the focused suites plus the inspector on the saved defective PDFs; then this record names the final combined commit.

**Group A: preparation, nothing live changes.**
- push the combined branch to `fleet-origin`;
- on the VPS: `scripts/fleet-build-runtime.sh` → pins (never placeholders);
- `scripts/fleet-rollout.sh rehearse <pins> 111 <to>`, a throwaway copy of the live data;
- the free rehearsals (services, founder upgrade, revision; fake provider, £0);
- a read-only snapshot of the cognition policy, tiers, routing, per-founder budgets and limits, AI-credit lots and holds.

Stop if anything differs from expectations.

**Group B: install and Anthropic, agents stay paused, no model call.**
- `scripts/fleet-release.sh <pins> 111 <to> <current UI> …`. Automatic restore is off by default; do not set
  `FLEET_ROLLOUT_AUTO_RESTORE`.
- Verify:
  - the runtime identity matches;
  - the schema is `<to>`;
  - policy, tiers, routing and budgets equal the snapshot;
  - flags false, cap 2, agents paused.
- Then, **only if item 5 confirmed the organisation:**
  - move the key back from the recovery folder to its controller credential;
  - runtime.env: `FLEET_INFERENCE_PROFILE=cloud_allowed` and `FLEET_COGNITION_PROVIDER=anthropic`;
  - `inference-profile-set cloud_allowed "<owner reason>"` if the profile is local_only;
  - re-enable the policy with the snapshot's exact values;
  - restart only `automaton-fleet.service`; `/v1/cognition/status` should show anthropic.
- Post the **approved** credit reconciliation, if its treatment was approved, from the Console figures.

**Group C: agents and the bounded evaluation.**
- `scripts/fleet-founders.sh` runtime upgrade, one agent at a time, still paused; record the upgrade IDs;
- the paid S1 evaluation on terms frozen by `fleet-scenario-terms.sh` (figures below, re-frozen); import once.

Resuming the agents' own work stays the owner's separate word.

## Rollback

- **Group A:** nothing live changed; delete nothing.
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
- **Group C, the runtimes:** `scripts/fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`.
- Once real money or provider data exists after Group B: freeze and fix forward (README §3).

## Proposed bounded evaluation (paid; separate approval)

Scenario S1 only (paid order, then a correction, on the approved Opus routing), cap **360p**, which bounds the run.
- Derived by code at plan C's frozen terms (1150p ↔ 1,281,805,763 µ¢): hold **401,260,935 µ¢ ($4.01)**.
- Plan C's actual S1: 278.50p.
- Optional S1 + S2 (two hard kills): cap **610p**, hold **679,914,362 µ¢ ($6.80)**; plan C actual 392.11p.

These figures are re-frozen at approval by `fleet-scenario-terms.sh`, with today's FX and lot. The run is approved only
on the frozen figures. The ledger's recorded credit is 1,676,179,930 µ¢ ($16.76).

The S1 grader does not open the PDF (desktop runs 3–5). With the desktop's inspector checks merged, broken files fail
review. The delivered files are still checked by hand before any pass is claimed.

## Remaining before approval

1. **Still missing from the transfer:**
   - the **later proposal archive** and its checksum (no `/mnt/fleetproposal` is mounted);
   - the desktop's **listing of retained or leftover registries**: `find /tmp -maxdepth 1 -name 'fleet-pg-*'` and, if a
     system cluster exists, `psql -l` plus `SELECT max(version) FROM fleet.fleet_schema_migrations` per database.
     It is not in the package.

   Nothing else in this candidate depends on them.
   - **Retained test clusters on this VM** (5, from 22–23 Oct; one at the original v112): stopping or deleting them is
     the owner's call; nothing was touched.
2. **Key organisation (owner, item 5):** the Console and metadata checks in the item 5 section above.
3. **Credit treatment:** approve (A) or (B) and the promotional lot design in the credit section; read the Console figures listed there.
4. **Correction obligation:** approve the proposed repair, or the stricter alternative, before it is implemented.
5. **Pre-existing failures:** 8 pre-existing failures (desktop: `fleet-cognition-anthropic`, `r24-experiments`, `research`,
   `storefront-gateway-pg`), 2 flaky tests (unnamed), and 1j's unhandled rejection. All are recorded and not hidden; none
   blocks this candidate.
