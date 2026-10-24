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
  (`text_off_page`, `text_overlap`, `pdf_content`), procedure cleanup and full delivery evidence. No desktop commit touches
  a migration, so migration numbering is unaffected: production v111, this candidate v112, nothing above it.
- This branch: `fleet/integration-v2.6` from 8077f6c. The desktop commits will be **merged** in, so neither history is
  rewritten (see "Remaining before approval").

## Changes in this candidate

1. **v112 no longer changes a provider on upgrade** (amended before its first application on any persistent registry; the
   runner records versions without checksums). As first written, v112 made every registry `local_only` and disabled its
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

## Identified, not changed: the `resolved:true` correction bypass

`fleet_customer_obligations` (v100, restated in v112) ends an order conversation at the latest of its last sent delivery
or its last agent message with `resolves` (an `order_message` sent with `resolved:true`). `revisionOwed` exists only while
the conversation is open. So an agent can answer a buyer's change request with `resolved:true` and no new delivery, and
the revision stops being owed. The first delivery cannot be bypassed this way: `deliveryOwed` follows the order's status.

The controller cannot tell from text whether a buyer's message asked for a change. A "thanks!" also opens `revisionOwed`,
and `resolved` is its legitimate close.

Proposed for the owner's decision, not built: when an agent resolves an order conversation without a later delivery,
FleetController records `revision_resolved_without_delivery`. It would appear in Fleet Command, and the buyer's next
message reopens the conversation as today.

## Item 5: which organisation owns the VPS runtime key

**Not established.** The key is in a root-only directory, and reading it needs sudo on the VPS, which this preparation
does not have. No recorded document names the key's organisation or workspace. The owner-side check is in "Remaining
before approval".

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

## Deployment (each numbered group needs the owner's explicit approval)

0. **Before approval:** merge the desktop bundle (below), rerun the focused suites plus the inspector on the saved
   defective PDFs, then rebuild. The candidate commit becomes that merge.
1. **Push** `fleet/integration-v2.6` to `fleet-origin` (approval 1).
2. **On the VPS, nothing live changes** (approval 2):
   - `scripts/fleet-build-runtime.sh` gives the pins (commit, build ID, lockfile; never placeholders);
   - `scripts/fleet-rollout.sh rehearse <pins> 111 112`, a throwaway copy of the live data;
   - the free rehearsals (services, founder upgrade, revision; fake provider, £0);
   - a read-only snapshot of the cognition policy, tiers, routing, per-founder budgets and limits, AI-credit lots and holds.
3. **Install** (approval 3): `scripts/fleet-release.sh <pins> 111 112 <current UI> …` (UI reused).
   - Automatic restore is now OFF by default, so do not set `FLEET_ROLLOUT_AUTO_RESTORE`.
   - Then verify: `fleet_runtime_verification` all match; schema 112; `fleet_inference_profile_state` recorded;
     policy, tiers, routing and budgets identical to the snapshot; flags false; cap 2; agents paused.
   - Cognition is still contained (provider none), so no inference is possible.
4. **Anthropic** (approval 4, after item 5 confirms the organisation):
   - move the key from `/etc/automaton-fleet/recovery/` back to the controller credential it was moved from;
   - runtime.env: `FLEET_INFERENCE_PROFILE=cloud_allowed`, `FLEET_COGNITION_PROVIDER=anthropic`;
   - if the profile is `local_only`, `fleet:admin inference-profile-set cloud_allowed "<owner reason>"`;
   - re-enable the policy with exactly the snapshot's values; restart only `automaton-fleet.service`;
   - `/v1/cognition/status` shows anthropic. Agents stay paused, so no call is made.
5. **Founder runtimes** (approval 5, agents paused): `scripts/fleet-founders.sh` upgrade, one agent at a time; record each
   upgrade ID.
6. **Paid evaluation** (approval 6): the terms below, frozen by `scripts/fleet-scenario-terms.sh`, hold placed, import once.

## Rollback

- **Steps 1–2:** nothing live changed; delete nothing.
- **Step 3 fails after the migration:** the rollout stops the controller-side units and **restores nothing** (the
  database, the pre-migration dump, runtime.env and logs are kept). The owner chooses fix forward (preferred) or
  `FLEET_ROLLOUT_AUTO_RESTORE=1 scripts/fleet-rollout.sh revert <pins> 111 112 <reason>`. That is an explicit restore of
  the verified pre-migration dump and loses everything recorded after it, so it is acceptable only before agents or
  cognition resume. 89d7c21 never runs on schema 112.
- **Step 4:** the 23 October containment again:
  - policy disabled;
  - `FLEET_COGNITION_PROVIDER=none`;
  - key back to the recovery folder;
  - restart the controller.

  Optionally `inference-profile-set local_only`, which disables cloud tiers and policy. No database restore.
- **Step 5:** `scripts/fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`.
- Once real money or provider data exists after step 4: freeze and fix forward (README §3).

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

1. **The desktop bundle (owner).** On the desktop, in Ubuntu:

   ```
   mkdir -p /mnt/c/FleetBackup && cd ~/automaton-fleet
   git bundle create /mnt/c/FleetBackup/desktop-all.bundle --all && git bundle verify /mnt/c/FleetBackup/desktop-all.bundle
   cp docs/evaluations/local-model/desktop-runs-2026-10-24.md /mnt/c/FleetBackup/
   tar -C ~ -czf /mnt/c/FleetBackup/desktop-local-demo.tgz local-demo
   cd /mnt/c/FleetBackup && sha256sum desktop-all.bundle desktop-local-demo.tgz desktop-runs-2026-10-24.md > desktop.sha256
   ```

   Then, in VirtualBox: Devices → Shared Folders → add `C:\FleetBackup` as `fleetbackup` (Make Permanent). On the VM
   (owner, sudo): `sudo mkdir -p /mnt/fleetbackup && sudo mount -t vboxsf -o uid=$(id -u),gid=$(id -g) fleetbackup
   /mnt/fleetbackup`. Claude then:
   - verifies the checksums;
   - fetches the bundle into `refs/desktop/*`, with no reset and nothing overwritten;
   - merges into `fleet/integration-v2.6`, keeping the database-authoritative hourly limit (the desktop has no rate-limit
     change);
   - reruns the suites and the inspector on the saved PDFs.
2. **Key organisation (owner, item 5).** On the VPS:

   ```
   sudo ls -l /etc/automaton-fleet/recovery/
   sudo bash -c 'K=$(cat /etc/automaton-fleet/recovery/<keyfile>); curl -sS -o /dev/null -D - https://api.anthropic.com/v1/models \
     -H "x-api-key: $K" -H "anthropic-version: 2023-06-01" | grep -iE "^(HTTP|anthropic-organization-id)"; echo "key ends ...${K: -4}"'
   ```

   Listing models is not inference. Compare the organisation ID with Console → Settings → Organization, for the
   organisation whose Billing shows the Max-included credits. Find the key ending in those 4 characters under Console →
   API keys, and note its workspace. If the response has no `anthropic-organization-id` header, the Console check alone
   decides.
3. **Credit accounting (owner decision).** Fleet's ledger authorises against its recorded AI-credit lots
   (1,676,179,930 µ¢). How the Max-included credits are recorded, as a new lot or not at all, is an owner economic-policy
   decision. It is not made here.
4. **Decide on the `resolved:true` bypass** (above).
5. **Pre-existing failures:** 8 pre-existing failures (desktop: `fleet-cognition-anthropic`, `r24-experiments`, `research`,
   `storefront-gateway-pg`), 2 flaky tests (unnamed), and 1j's unhandled rejection. All are recorded and not hidden; none
   blocks this candidate.
