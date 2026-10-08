# R41.1 revised candidate `fda78a0` (owner amendment, 2026-10-08)

**This supersedes candidate `92c691c` and all of its commands.** Do not deploy `92c691c`.

| Stage | Status |
|---|---|
| Code complete | **yes**: `d15b76a` (amendment) + `fda78a0` (reconciliation fix found by the rehearsal), pushed to `fleet/final-v2.4` |
| Rehearsed | **yes**: local real-process founder rehearsals; production-copy rollout and upgrade rehearsals on the VPS (below) |
| Deployed | **no** |
| Behaviourally verified | **no**: comes after the owner's upgrades (step 4 and 5 below) |

## Pins (`pins.txt`, built on the VPS by `scripts/fleet-build-runtime.sh` after the build finished)

```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=fda78a0eeaa8af87bd8725b7bf1df0c1bea315db
FLEET_RUNTIME_BUILD_ID=451c91a8ce5f9a1558d5a245fd431bdf503f93f697b868d02d27a83ea137d4ae
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```

Schema: 45, unchanged (code-only release). Production now runs `136c4bd` (controller, Agent 2) and `94f09a7` (Founder 1).

## Tests (local, 2026-10-08)

| Suite | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| R41.1 continuation, F2-A autonomy, live-01, live-01-pg, r23 cognition, cognition routing, **r41-1 tools-pg** (pinned Chromium), browser-pg | 127 / 127 |
| release-script, reconcile-pg (+ the code-only re-approval test), event-history-pg | 14 / 14 |
| research | 26 / 26 (the `browser` assertion now states the brokered `planning` tool; raw network primitives still denied) |
| founder upgrade, real processes, from `eea1932`, `136c4bd`, `94f09a7` | all pass, including 4 concurrent runs each way; checks include "rollback after v5 use" and "upgrade again after the v5 rollback" |
| `pnpm test:security` | 1379 pass / 1 fail, pre-existing: F2 static audit (`payment_order_awaiting_owner`, R39) |
| `pnpm test:financial` | 753 pass / 1 fail, pre-existing: F2-A v27 (1, 2, 5) (same R39 cause) |

A first security run also failed the founder rehearsal once. Cause: the v5 check read the journal before the founder's
own journal-writing turn had run under load, and the new rollback check inherited the miss. Fixed by waiting for the
observable outcome; it then passed 4 of 4 concurrent runs from each release.

## Production-copy rehearsals on the VPS (live untouched)

- `rollout-rehearsal-45-45.txt`: the live dump restored to a copy; row counts identical; migrate-check nothing to apply;
  reconciliation OK; ledger verifies; the dump restores to schema 45 with the same ledger head. **PASSED.**
- `upgrade-rehearsal-45-45.txt`: on a throwaway copy, the candidate controller, Operator API and dashboard ready; Fleet
  Command and history reads; ledger head unchanged. Then the **code-only rollback**: the previous runtime `136c4bd`
  re-approved, the database NOT restored, and the reconciliation shows every candidate-era write preserved. The previous
  controller and dashboard are ready on the same unrestored data. The disaster-path dump restore is still verified.
  **PASSED.**
  - The first run (on `d15b76a`) failed closed: re-approval legitimately changes `fleet_state.runtimeCommit`. `fda78a0`
    allows exactly that field to change with `runtime_approved`. Population, cap and mode must still match (tested).
  - Few candidate-era writes existed on the copy (the role-grant and approval events, no new journals), so the proof
    shows the mechanism: no restore, and a full reconciliation of whatever was written.

## Deployment commands (owner; each step separate)

All run on the VPS from `~/automaton-fleet-build` (already at `fda78a0`, pins in `~/r411-pins.txt`).

1. **Controller cutover** (code only, 45 → 45). Both agents keep their runtimes and are served v4.
   `bash scripts/fleet-rollout.sh cutover ~/r411-pins.txt 45 45`
2. **Browser worker** (after step 1; needs sudo, apt, a new OS user, DB roles, a systemd unit).
   - `sudo scripts/fleet-browser-setup.sh install` prints the plan; nothing changes.
   - `sudo scripts/fleet-browser-setup.sh install --zip ~/r411/chs.zip --apply`
     (or omit `--zip` to download; the sha256 is checked either way).
   - `sudo scripts/fleet-browser-setup.sh check` must report every line present, and the self-test seen.
3. **On-host founder upgrade rehearsals** (throwaway registry, real systemd host, fake provider):
   - `sudo scripts/fleet-founders.sh upgrade-rehearsal 136c4bd72f8ef00cd4556ac33df7a5c3c3f9cf89`
   - `sudo scripts/fleet-founders.sh upgrade-rehearsal 94f09a7c44f528b8a632e16565e0fedf5ee56d2f`
4. **Agent 2** (`01M4C4NXT786Q4E9725N5A15KV`), owner gate:
   - `sudo scripts/fleet-founders.sh upgrade-preflight 01M4C4NXT786Q4E9725N5A15KV`
   - `sudo scripts/fleet-founders.sh upgrade-runtime 01M4C4NXT786Q4E9725N5A15KV`
   - Then behavioural verification (read-only): it is served founder-v5 (no `FLEET_DOCTRINE_INCOMPATIBLE`), it uses v5
     tools, and it keeps identity, memory, credential, wallet and work.
5. **Founder 1** (`01M3F50SH7PNX2E3GST13J52AS`), only after Agent 2 is verified: the same two commands with its id.

## Rollback

- **A founder:** `sudo scripts/fleet-founders.sh rollback-runtime <agentId> <upgradeId> <reason>`. Code only. Its state
  is kept and the previous runtime runs on it (proven from both releases). Its runtime asks for no doctrine and gets v4.
- **The controller:** roll the founders back first, and stop the browser worker (`sudo systemctl disable --now
  automaton-fleet-browser`): it is installed after the cutover, so the cutover state does not list it and the revert
  would not stop or restart it. `136c4bd` ignores the doctrine field, so a v5 runtime would silently
  get v4. Then `bash scripts/fleet-rollout.sh revert ~/r411-pins.txt 45 45 <reason>`:
  - it re-approves `136c4bd` and does **not** restore the database;
  - every post-cutover write is reconciled and kept;
  - `production_rolled_back` records mode `code-only` and the preserved counts.
- **The browser worker alone:** `sudo systemctl disable --now automaton-fleet-browser`. It holds no vault and no state
  worth keeping. Its role can stay, since it grants `bx_*` only.

## Pre-deployment verification (2026-10-08)

- **Order:** cutover, then browser setup. The cutover's migrate step grants only roles that exist (the browser role does
  not yet), and `fleet-browser-setup.sh` refuses to run until the installed release carries `grant-browser-role`.
- **Wake limits do not restrict work:**
  - `RENUDGE_UNDECLARED_MAX` only spaces full reassessment pushes while the state is unchanged and the founder only
    sleeps; at 10 instead of 32 it makes them more frequent.
  - Any working turn resets the idle backoff and gets a full packet; there is no limit on turns, steps or tools.
  - Any change in memory, workspace, economy, capabilities or dependency status, a sale, or a due review time gives a
    full packet.
- **Pre-existing latency, unchanged by R41.1 (F2-A/R23):** after a sleep-only turn, the idle skip backs off up to 32
  thinking slots (60 s each in production) without inference. An event arriving then is seen at the next slot that
  runs, at most about 32 minutes later. It delays the wake but never suppresses it.

## Needs additional authority

- The controller cutover and every founder upgrade or rollback (production).
- Browser provisioning: sudo; apt packages; a new OS user; DB role creation as `postgres`; `/etc/automaton-fleet/browser.env`; a new
  enabled systemd unit.
- Unchanged and not touched: payments, owner sweeps, replication, live external spending, the cap (2), the mode
  (DEVELOPMENT), and mail/SMS providers (dormant).
