# Release d63a595 — schema 69 → 72 (AI credit: funding sources, evidence-first purchase accounting, acquisition cost), UI 0.17.1 unchanged

Status: **DEPLOYED 2026-10-12 19:54:33Z** (owner go: "Once those pass, you are authorised to deploy the corrected
candidate"). Supersedes `release-e641872.md` (identical application code; its one attempt was rolled back). Both agents
stay paused on b60e262 (Agent-2 a paused reserve; the founder runtime is unchanged, no agent upgrade); no balance, funding,
custody activation, survival protection or live flag changed; no money moved.

## Pins (VPS build `~/rlc72b/build.log`; an independent local build is identical)
```
FLEET_RUNTIME_REPO=https://github.com/5l4mm3r/automaton-fleet.git
FLEET_RUNTIME_COMMIT=d63a5958b68d2ceeb3e790c74bab12cab79da88d
FLEET_RUNTIME_BUILD_ID=88c24dc413ecc3f2bc65d791414074a1e7ef3348cdc6c62d89f1cda0e4b82c6c
FLEET_RUNTIME_LOCKFILE_SHA256=1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1
```
UI `~/rlc72b/ui-0.17.1-d63a595.tgz`, sha256 `c4e97e1535f75a4609ec355ec73c8377729c431b1434f662b13b8124a6071160` (the deployed 0.17.1,
byte-identical).

## Contents
- Application: exactly e641872's (`git diff e641872 d63a595 -- src ':!src/__tests__'` is empty): v70 AI-credit lots by
  funding source, v71 evidence-first purchase accounting, v72 acquisition cost by consumption + console reconciliation
  (spec §25 – §27; `release-e641872.md` for contents and validation, reused unchanged).
- Release tooling — the three defects of the 19:27Z attempt, fixed:
  1. `fleet-ui-deploy.sh`: an existing UI directory byte-identical to the tarball (paths, types, modes, owner, contents) is
     reused; when it is already served, it is only verified (no switch, no restart). A differing directory is quarantined
     to `/opt/automaton-fleet/quarantine/ui-<name>-<stamp>` with an evidence file (never deleted); a served one that
     differs is refused. `--check` makes every decision without changing anything. Env backups are per attempt.
  2. `fleet-release.sh`: preflight `fleet-ui-deploy.sh --check` before anything changes; a snapshot of `dashboard.env` as
     live immediately before the release (`dashboard.env.before-release-<commit7>-<stamp>`); a rollback restores and
     verifies exactly that UI — never an older `dashboard.env.pre-<name>`.
  3. `fleet-rollout.sh cutover`: every retry guard (leftover `runtime.env.pre-<commit7>`, the rollback target, the candidate
     build — now staged from the pins file, not runtime.env — and an existing `releases/<commit>`) runs before
     `runtime.env` or `current` change. An existing release directory is reused only when `fleet-release-reuse.sh` verifies
     it complete against the staged pinned build (manifest of every path / type / sha256 / symlink target, root-owned, read-only,
     its CLI's build identity — nothing in it is executed before the contents match); otherwise it is quarantined with
     evidence (`/opt/automaton-fleet/quarantine/release-<commit>-<stamp>` + `.evidence.txt`). A failure before the outage
     restores `runtime.env` and `current`; every restore moves its backup aside, so a corrected retry is not blocked.

## Validation
- Focused release-tooling tests: `fleet-release-script.test.ts` 8/8 (incl. the restore of the UI live before the attempt,
  not the older backup; preflight refusal changes nothing), `fleet-release-tooling.test.ts` 18/18 (UI reuse / already
  served / quarantine / served-and-differs refused / `--check`; release-directory reuse vs quarantine on content, symlink,
  writability and identity differences and an interrupted install; cutover guard ordering).
- Application validation reused from e641872 (unchanged code).
- On the host, read-only: `fleet-ui-deploy.sh --check 0.17.1` → "would be reuse, already served (no switch, no restart);
  nothing changed" (19:52:04Z).

## Rehearsal (2026-10-12 19:52:13–19:52:31Z) — PASSED
Dump `automaton_fleet-v69-rollout-d63a595-20261012T195213Z.dump` (sha `af65b5a1…`); restore identical; wouldApply [70, 71, 72];
health on 72; reconciliation OK (1 new account at zero; 806 journals; 2436 events preserved); ledger verifies; re-run no-op;
rollback proof to 69.

## Deployment (19:52:52 – 19:54:33Z; outage 19:53:42 – 19:54:26Z)
- Preflight: UI 0.17.1 reuse, already served; snapshot `dashboard.env.before-release-d63a595-20261012T195252Z`.
- Backend: pre-migration dump `automaton_fleet-v69-pre-v72-20261012T195402Z.dump` (sha `cdc2cbaa…`); migrate 70, 71, 72;
  reconciliation OK (2436 events preserved); doctor DEPLOYMENT OK; release `releases/d63a595…` installed fresh.
- UI: "already served and verified (unchanged UI; no switch, no restart)"; root verification through the public edge passed;
  one `production_deployed` (event 5311).
- Verified after: Agent-1 / Agent-2 identity hashes, ledger fingerprints and cash (8641 / 9536 pence) identical to the
  baseline taken at 19:52:41Z; 806 journals; ledger head 843 `cccef7560f798f40`, verifies; schema 72; both agents paused
  (cognition paused = true) on b60e262; survival protection on; custody activations 0; cap 2/2 DEVELOPMENT; replication,
  payments, owner sweep, dry-run child all false; readyz 200; admin edge 200; all units active. New events: the migration's
  role grants, `runtime_approved`, the deployment, and the two `api_auth_failed` seen at every cutover restart.
- Rollback (fix forward once any lot, receipt, policy or reconciliation is recorded): UI unchanged, so backend only —
  `bash ~/rlc72b/fleet-rollout.sh revert ~/rlc72b/pins.txt 69 72 <reason>`.
- Left in place (inert, documented): `releases/e641872…` (installed by the failed attempt, never served; a different commit, so
  it blocks nothing — remove only with the owner's approval); `runtime.env.pre-e641872.reverted-20261012T1929Z`,
  `.attempt3-20261012T1931Z`; `dashboard.env.after-e641872-rollback`.

## Dashboard database credential rotated (2026-10-12 19:56Z, owner instruction)
The `fleet_dashboard_login` password (exposed in a transcript earlier on 2026-10-12) was replaced: a new random password,
generated on the host and sent to PostgreSQL only as a SCRAM-SHA-256 verifier; written into `dashboard.env` and the 16
dashboard.env backups / snapshots that held the old one (so no UI rollback can restore a dead or exposed credential);
ownership and modes unchanged; neither value was printed. After: the dashboard restarted on schema 72 with a live DB
session, login page 200, unauthenticated read 401; the new password logs in, the old one is refused; no authentication errors.
