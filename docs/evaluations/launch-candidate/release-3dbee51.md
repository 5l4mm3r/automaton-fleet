# Release 3dbee51 — coordinated: schema 65 → 68 + UI 0.17.0, then the founder runtime upgrade

Status: **rehearsed, not deployed** (2026-10-12 16:13:11Z). Supersedes `release-befae84.md` (v66 alone is not deployed
separately — owner, 2026-10-12). No money moved; agents paused; live settings unchanged.

## Contents
- **v66** capital backing — a real PayPal deposit backs the capital recorded without money (no second credit); spec §21.
- **v67** business foundation in the shared library (33 entries incl. owner §1–§2; one dated `fleet-capability-status`);
  full read by `knowledge.library {path: "foundation", part}`; `eventsDigest`; Charter v6 standing summary; spec §22.
- **v68** lesson supersession through Fleet Control's review (history immutable; read_knowledge shows current and
  retired lessons) and `recentEvents` for the wake packet; spec §23.
- **UI 0.17.0** — Capital backing panel and deposit action (unchanged since befae84; same package hash).
- **Founder runtime** (in the same tree; reaches the agents only through the per-agent upgrade): Field Guide v2.1; wakes on
  agent-facing events and says what happened; read_knowledge passes retired lessons through.

## Pins (VPS build `~/rlc68/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=3dbee51d92d49c1ada59f55e1746cf15aa1b2cb2
FLEET_RUNTIME_BUILD_ID=6d572c58de781914317803d85cda49dd286765276d6130311c1f9b137e81013c
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
- UI `~/rlc68/ui-0.17.0-3dbee51.tgz`, sha256 `5c00add080a156b81b96724db311464347eaf88d63c49b52a84da43138fc029a` (two builds
  byte-identical; verified on the VPS).
- Scripts unchanged: `fleet-release.sh` fe43b2dd…, `fleet-rollout.sh` 5e007b46…, `fleet-ui-deploy.sh` 5bef3755….

## Validation (focused; unaffected results reused)
- v66 5/5 (+ 15 files 140/140 earlier); v67 4/4; v68 7/7 — real event paths (broker mail, spend review opened and decided,
  owner card decision, PayPal dispute, lesson review, supersession); founder-conversation 7/7 (wake on events, the "since
  your last turn" line, the owner's pause holds; fails without the fix).
- 26 focused files 297/298; the one failure (v68 had restated the event routes from v65, dropping `capital_backed`) was
  fixed and the affected files re-run 25/25. `tsc` clean; dashboard simulation and live build unchanged.

## Rehearsal (2026-10-12 16:12:49–16:13:11Z) — PASSED
- Dump `automaton_fleet-v65-rollout-3dbee51-20261012T161253Z.dump` (sha `fea974fa…`); restore row counts identical.
- wouldApply [66, 67, 68]; health on schema 68; reconciliation OK (806 journals; 2364 events preserved); ledger verifies;
  re-run no-op; rollback proof back to 65 with the same ledger head.
- Cut over before 2026-10-13 16:13:11Z, or rehearse again.

## Order (each step on the owner's go; agents stay paused throughout)
1. Controller + UI (~45 s outage):
   ```
   bash ~/rlc68/fleet-release.sh ~/rlc68/pins.txt 65 68 0.17.0 ~/rlc68/ui-0.17.0-3dbee51.tgz 5c00add080a156b81b96724db311464347eaf88d63c49b52a84da43138fc029a
   ```
   Rollback: UI `dashboard.env.pre-0.17.0`; backend `bash ~/rlc68/fleet-rollout.sh revert ~/rlc68/pins.txt 65 68 <reason>`
   (fix forward once a backing or a supersession is recorded).
2. Founder runtime upgrade rehearsal from the installed release (`fleet-founders.sh upgrade-rehearsal 973e0c1…`), then
   `upgrade-preflight` / `upgrade-runtime` Agent-2, then Agent-1 — only possible after step 1 installs the release.
3. After both: the capability-status wake fact describes runtime 973e0c1 or earlier, so reload it as version 2 stating the
   new behaviour (a library load, no schema change).
