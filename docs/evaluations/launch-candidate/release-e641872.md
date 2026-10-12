# Release e641872 — schema 69 → 72 (AI credit: funding sources, evidence-first purchase accounting, acquisition cost), UI 0.17.1 unchanged

Status: **SUPERSEDED by release-d63a595.md** (same application code + corrected release tooling; deployed 2026-10-12
19:54:33Z). This commit was never served: its one attempt was rolled back (below). Originally: implemented and rehearsed (2026-10-12 19:20:03Z). **Not yet verified with a real forwarded receipt
or a real treasury debit.** Supersedes `release-828c71f.md`. Production: b60e262 / schema 69; both agents paused on b60e262
(Agent-2 a paused reserve); no balance changed; no money moved.

## Pins (VPS build `~/rlc72/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=e641872492c02a0af9c602c6830cc79d7961e0b8
FLEET_RUNTIME_BUILD_ID=0059ccad04004c583df34473578bbce0cc0d4203df959ece342d4b422eab23e9
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc72/ui-0.17.1-e641872.tgz`, sha256 `c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160` (unchanged; identical to
the deployed 0.17.1). Scripts unchanged. The cutover cycles custody. Founder runtime unchanged since b60e262 (no agent upgrade).

## Contents
v70 (lots by funding source) · v71 (receipts and debits as provisional observations; unambiguous one-to-one promotion; owner
confirm / reject; receipts read before tax) · v72 (acquisition cost from evidence, allocated by consumption — agents for
their own work, treasury for owner conversations and Fleet Control — funded as the lot was; console reconciliation that never
assigns a funding source; capability status v4, bf-ai-costs v2). Spec §25 – §27.

## Validation (focused)
v70 3/3 · v71 5/5 · v72 5/5 · v69 3/3 · v66 5/5 · routing invariant (every AI charge owes exactly its cash) · ledger ·
event routing · migration paths (no journal from any migration; added accounts at zero) · v67 library — 71/71 + 9/9.
Earlier focused runs (mail paths, custody worker, PayPal, live contract) reused: unaffected by v72.

## Rehearsal (2026-10-12 19:19:4x–19:20:03Z) — PASSED
wouldApply [70, 71, 72]; health 72; reconciliation OK (1 new account at zero; 806 journals; 2429 events preserved); ledger
verifies; re-run no-op; rollback proof to 69. Cut over before 2026-10-13 19:20:03Z, or rehearse again.

## Cutover (owner go; ~45 s; agents stay paused)
```
bash ~/rlc72/fleet-release.sh ~/rlc72/pins.txt 69 72 0.17.1 ~/rlc72/ui-0.17.1-e641872.tgz c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160
```
Rollback: `bash ~/rlc72/fleet-rollout.sh revert ~/rlc72/pins.txt 69 72 <reason>` (fix forward once anything is recorded).
Then the ordered list in `launch-checklist-v65.md` ("Onboarding to launch").

## Deployment attempt 2026-10-12 19:27–19:31Z (owner go) — ROLLED BACK; production restored and verified
- `fleet-release.sh`: the backend cutover succeeded (schema 72, readyz 200, 19:28:29–19:29:12Z), then the UI step refused
  ("/opt/automaton-fleet/ui/0.17.1 exists — UI directories are immutable": the UI was unchanged and already live). The
  release rolled itself back as designed: database restored from the verified pre-migration dump
  (`automaton_fleet-v69-pre-v72-20261012T192849Z.dump`; 0 journals / 3 events after the cutover kept in
  `automaton_fleet-v72-post-cutover-e641872-20261012T192939Z.dump`), backend to b60e262, `production_rolled_back` recorded.
- Tooling defects found: (1) the release requires a NEW UI directory even when the UI is unchanged; (2) its UI rollback
  restored `dashboard.env.pre-0.17.1` (= 0.16.0) instead of the UI live before the release; (3) a retried backend cutover
  is refused because `releases/<commit>` from the failed attempt exists (immutable), after it has already rewritten
  `runtime.env`'s pins.
- Repairs (within the deployment authorisation, restoring the pre-deploy state): UI pointer back to 0.17.1 (root serves the
  0.17.1 tree); `runtime.env` restored to the pre-deploy file (b60e262) after the refused retry; the two leftover backups kept as
  `runtime.env.pre-e641872.reverted-20261012T1929Z` and `.attempt3-20261012T1931Z`.
- Verified after: identity hashes, ledger fingerprints and cash identical; 806 journals; head 843; ledger verifies; schema
  69; both agents paused on b60e262; credit, owner payable (0), survival protection, custody (off, 0 activations), cap 2/2
  DEVELOPMENT and all live flags unchanged; all units active; readyz 200.
- Remaining before a retry: the stale `/opt/automaton-fleet/releases/e641872…` (installed by the failed attempt, never served)
  blocks a backend-only cutover — removal needs the owner's approval — and the tooling defects above. **Resolved by
  release-d63a595.md** (the defects fixed in d63a595; a new commit, so the stale directory blocks nothing and is left in place).
