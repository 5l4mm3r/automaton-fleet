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
- **Correction (owner, 24 Oct):** the desktop also has its own hourly-limit implementation, **f9db421**, and a **v113**
  migration, and it applied the original v112 in its test environments. An earlier draft of this record wrongly said the
  desktop had no rate-limit change and no migration. None of those commits is on the VM yet, so the reconciliation of
  the three hourly-limit implementations (8077f6c, f9db421, this branch's eligibility time) and of v112/v113 is
  **pending the transfer**. Production's history is unaffected either way: v111 applied, nothing later.
- This branch: `fleet/integration-v2.6` from 8077f6c. The desktop commits will be **merged** in, so neither history is
  rewritten (see "Remaining before approval").

## Changes in this candidate

1. **v112 no longer changes a provider on upgrade** (DRAFT: production has never applied v112, but the original was applied
   in desktop test environments. Whether this amendment stands, or v112 stays as applied and the change moves to a later
   migration, is decided from the desktop's retained registries and its v113.) As first written, v112 made every registry `local_only` and disabled its
   enabled cloud tiers and policy as it ran. Now:
   - a registry with an enabled cloud tier or cloud policy is recorded `cloud_allowed`, and its configuration is kept;
   - any other registry is `local_only`, and cloud requires the owner's recorded `inference-profile-set`. That includes
     the contained production registry, unless its tiers are still enabled; the pre-deploy snapshot settles which.

   The trigger guard and the owner function are unchanged. Returning to `local_only` still disables cloud tiers and policy.
   The controller's own gate is unchanged: `FLEET_INFERENCE_PROFILE` defaults to `local_only`, and the controller refuses
   to start with a cloud provider unless runtime.env sets `cloud_allowed`. That is a loud, explicit deployment setting,
   never a silent switch.
2. **The hourly call limit is controller-authoritative.** v112's `svc_cognition_authorize` returns `retryAfterS`, the
   moment enough of the last hour's calls leave the window (1..3600 s). The gateways carry it, the server sends it as
   Retry-After, the client reads it, and the founder rests until then. 8077f6c's 60 s is kept only as the fallback when no
   time is given. This replaces "retry every second" (desktop run 2: 40 minutes) and "a fixed minute".
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

The migration number follows the v112/v113 decision.

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

## Tests (non-billable; no inference call, no network beyond loopback)

`npx tsc --noEmit` is clean. Focused suites (one run, 14 files):
- **13 files passed, 204 tests**:
  - privileges and least-privilege audits: `fleet-phase4` 53, `fleet-cognition-hardening` 16;
  - cognition and controller profile: `fleet-cognition` 23, `-routing-pg` 8, `-routing` 26, `-accounting` 11, `-local` 7;
  - migrations: `fleet-v112-local-inference-pg` 5, including the new upgrade and eligibility tests;
  - obligations: `fleet-v100-obligations-pg` 11;
  - founder runtime: `work-continuity` 29 (new 1s), `retry-after-fix` 7, `procedures` 5, new `fleet-client-retry-after` 2.
- `fleet-f2-migration-paths-pg` timed out at its 30 s limit while 13 PostgreSQL suites ran in parallel. Alone it passes
  2/2 (v25→v30 step by step, and direct upgrades from v8 and v24 to v112 with a clean audit).
- Release tooling: `fleet-release-tooling` 22 (2 new: no restore without approval) and `fleet-release-script` 9.
- Known and unchanged: `work-continuity` 1j logs an unhandled rejection from its mock provider, present since 51a1f82.

**Not yet run here:** the saved defective PDFs from desktop runs 3–5 against the inspector. They are on the desktop with its
commits, and run once the bundle arrives.

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

1. **Transfer (owner).** Use the existing, verified package `C:\Users\o\Documents\fleet-desktop-preserve-20261024\`;
   it is not recreated. From it the VM needs:
   - the git bundle (all refs, including f9db421, v113, 9409e8a…90b5782 and any later commit);
   - its checksum manifest;
   - the evidence archive: the `local-demo` runs, including runs 3–5's delivered defective PDFs and any later run;
   - the record of which desktop registries were retained, and their `fleet_schema_migrations` versions, if the package
     has it.

   Separately, the **later proposal files** in their own transfer archive, with that archive's checksum.

   If the package has no registry listing, the desktop session produces it read-only and adds it to the proposal archive:
   `sudo -u postgres psql -Atc "SELECT datname FROM pg_database WHERE NOT datistemplate"`, then per database
   `SELECT max(version) FROM fleet.fleet_schema_migrations`. Also list leftover test clusters:
   `find /tmp -maxdepth 3 -name PG_VERSION`.

   VirtualBox: Devices → Shared Folders. Add the package folder as `fleetpreserve`, and the proposal archive's folder as
   `fleetproposal`, both with **Read-only** ticked and Make Permanent. On the VM (owner):

   ```
   sudo mkdir -p /mnt/fleetpreserve /mnt/fleetproposal
   sudo mount -t vboxsf -o ro,uid=$(id -u),gid=$(id -g) fleetpreserve /mnt/fleetpreserve
   sudo mount -t vboxsf -o ro,uid=$(id -u),gid=$(id -g) fleetproposal /mnt/fleetproposal
   ```

   Claude then:
   - verifies every checksum against the package's own manifest;
   - copies the files into a VM evidence folder;
   - fetches the bundle into `refs/desktop/*`, with no reset and no overwrite;
   - compares and merges onto `fleet/integration-v2.6`.
2. **Key organisation (owner, item 5):** the Console and metadata checks in the item 5 section above.
3. **Credit treatment:** approve (A) or (B) and the promotional lot design in the credit section; read the Console figures listed there.
4. **Correction obligation:** approve the proposed repair, or the stricter alternative, before it is implemented.
5. **Pre-existing failures:** 8 pre-existing failures (desktop: `fleet-cognition-anthropic`, `r24-experiments`, `research`,
   `storefront-gateway-pg`), 2 flaky tests (unnamed), and 1j's unhandled rejection. All are recorded and not hidden; none
   blocks this candidate.
