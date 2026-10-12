# Release e641872 — schema 69 → 72 (AI credit: funding sources, evidence-first purchase accounting, acquisition cost), UI 0.17.1 unchanged

Status: **FROZEN candidate — implemented and rehearsed, not deployed** (2026-10-12 19:20:03Z). **Not yet verified with a real forwarded receipt
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
