# Candidate fleet/integration-v2.6 (24 Oct 2026): Anthropic reasoning restored, local-run fixes kept

**Owner instruction, 24 Oct 2026:** resume the original arrangement: the VM for development, the existing VPS for unattended
runtime, the Anthropic API for reasoning (the owner's Max-included API credits), and Fleet's library and local tools for
storage and execution. No subscription-authentication adapter, no further Qwen-specific launch work. This record covers
local integration and preparation only. Nothing has been pushed, deployed, restored, or paid for.

## Final candidate

**c6d4699** on `fleet/integration-v2.6` (local, not pushed). Its parents are the merge 11126f0 (VM 2992394 + desktop
c6e3d85). Schema 111 → 114. This record is updated by a docs-only commit on top. The build is made from the pushed
commit at deployment Group A, and its pins come from that build's output.

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

## Deployment proposal: one package, three approval groups

**Package:** the final commit on `fleet/integration-v2.6` (named in "Final candidate" below). Schema **111 → 114**
(v112 amended, v113 desktop, v114 correction obligation). UI unchanged (the current UI is reused).

| Group | What happens | Live effect | Cost |
|---|---|---|---|
| **A: prepare** (nothing live changes) | Push the branch. On the VPS: `fleet-build-runtime.sh` → pins (from its output, never placeholders). `fleet-rollout.sh rehearse <pins> 111 114` on a **fresh read-only dump of production** (the historical test clusters are not inputs). The free rehearsals (services, founder upgrade, revision; fake provider). A read-only snapshot of the cognition policy, tiers, routing, budgets, AI-credit lots and holds. | none | £0 (no inference; build time only) |
| **B: install and Anthropic** (agents paused) | `fleet-release.sh <pins> 111 114 <current UI>`, automatic restore off (default). Verify: runtime identity, schema 114, policy/tiers/routing/budgets equal the snapshot, flags false, cap 2. Then, **only after the key check confirms the funded organisation**: key from recovery to its credential; runtime.env `FLEET_INFERENCE_PROFILE=cloud_allowed`, `FLEET_COGNITION_PROVIDER=anthropic`; `inference-profile-set cloud_allowed "<reason>"` if the profile reads `local_only`; policy re-enabled with the snapshot's values; restart only `automaton-fleet.service`. | controller outage ≈ 45 s (the 89d7c21 install took 45 s) | £0 (agents paused, so no model call) |
| **C: agents and evaluation** | `fleet-founders.sh` runtime upgrade, one agent at a time, still paused. The **reconciliation report** computed (nothing posted). Then the paid S1 evaluation on frozen terms, imported once. | founder processes restart; still paused | S1 cap **360p**; hold **401,260,935 µ¢ ($4.01)** at plan C terms, re-frozen at approval (plan C's actual S1: 278.50p) |

Resuming the agents' own work stays a separate word from the owner. Credit postings follow only the owner's decision on
the reconciliation proposal.

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

1. **Owner checks:** the key check above (four characters on the VPS, then the Console), and the Console figures for the
   reconciliation (G, Rp, Rb, Uc).
2. **Owner decisions:** the internal agent charge for promotional-funded calls (none, or list price shown separately),
   and how the reconciliation is posted. Nothing is posted until then.
3. **Not blocking:**
   - the later proposal archive: documentation to transfer when convenient;
   - the desktop's cluster inventory: those clusters are historical and excluded.
4. **Known and recorded:** the 8 failures the desktop recorded in `fleet-cognition-anthropic`, `r24-experiments`,
   `research` and `storefront-gateway-pg` (present before this work; not in the release evidence set).
