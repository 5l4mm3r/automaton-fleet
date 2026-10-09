# Release package — candidate f021673 (schema 45 → 59, dashboard 0.12.0)

Prepared and rehearsed 2026-10-09; **DEPLOYED 2026-10-09 22:06:31Z** on the owner's authorization (see the end). Founders
remain on `fda78a0`; all four safety flags false; survival protection ON. Supersedes `release-8e71fd6.md` (that package lacks v59 and its v58 note fails to apply once v59's wording is in).

## Identity

| | |
|---|---|
| Release commit | `f021673167effb9d619f41f39e9d3d9b9c262eab` (`fleet-origin/fleet/final-v2.4`), tree `4217023192f065f8b2fe2487c028fcd190373374` |
| Runtime build ID | `0f7c6a6f0c716730f5dd1ec3e3639126b1888c02ab525765e0d2bc6281991da5` — VPS build and an independent local build agree |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged from production) |
| Pins file (VPS) | `~/rlc59/pins.txt` (the four lines printed by `scripts/fleet-build-runtime.sh`) |
| Dashboard | 0.12.0 — `~/rlc59/ui-0.12.0-f021673.tgz` (VPS), `/var/tmp/automaton-fleet-ui-build/ui-0.12.0-f021673.tgz` (build VM) |
| Dashboard SHA-256 | `9f1742fe071a1c42c97632545741ca01e10746630fdbfcefadc57d387e6db7f0` (verified on the VPS after transfer; live tree digest `b8ea6123…4536`, reproduced by a second build at the fixed build path) |
| Release scripts | `~/rlc59/fleet-{rollout,release,ui-deploy}.sh`, byte-identical to the commit; `~/fleet-rollout.sh` kept for the R41.1 rollback |

## Closing validation (frozen tree f021673, 2026-10-09 20:14:49–20:33:36Z) — PASSED

Tree identity recorded before and after the run (HEAD f021673, 0 dirty files both times).

| Check | Result |
|---|---|
| `npx tsc --noEmit` | pass |
| `test:security` | 48/48 files, 1384 passed, 1 skipped |
| `test:financial` | 40/40 files, 836 passed, 1 skipped |
| Operating-loop files not in those selections | 9/9 files, 65 passed |
| Dashboard typecheck / lint / simulation / live build | pass |

The session that ran it was killed by the VM's OOM killer at 20:29Z (Firefox plus 36 leftover test PostgreSQL clusters on
an 8 GB VM without swap); the run itself completed. Logs are kept outside the repository on the build VM:
`~/fleet-release-evidence/f021673/validation/` (with `SHA256SUMS`). The leftover clusters were stopped afterwards.

## Rehearsal (`fleet-rollout.sh rehearse ~/rlc59/pins.txt 45 59`, 2026-10-09 21:49:33–21:49:54Z) — PASSED

- Production dump `~/automaton_fleet-v45-rollout-f021673-20261009T214937Z.dump`, SHA-256 `d431d3f8…13bf`; restored to a
  disposable database, row counts identical.
- migrate-check 45 → 59 would apply 46–59; migrate applied; schema 59, counters consistent.
- Reconciliation OK: 11 new accounts at zero; 751 journals; 1,324 events preserved, none purged; only the seven role-grant
  events appended. Ledger verify true.
- Re-run applies nothing; rollback proof: the dump restores to schema 45 with the same ledger head.
- Stamp `~/rollout-f021673-rehearsal.ok` — the cutover must start before **2026-10-10 21:49:54Z**, or rehearse again.

## Additional checks on a second disposable copy (same dump; dropped afterwards; `~/rlc59/check59.sh`)

| Check | Founder 1 (`01M3F50SH7PNX2E3GST13J52AS`) | Agent 2 (`01M4C4NXT786Q4E9725N5A15KV`) |
|---|---|---|
| Status / identity | active / unchanged | active / unchanged |
| Ledger | 17 accounts unchanged, 3 new at zero | 17 accounts unchanged, 3 new at zero |
| Cash = survival equity (before and after) | 8,747 | 9,638 |
| Wallet measure | funded, spendable 8,747, not exhausted | funded, spendable 9,638, not exhausted |
| Dispute exposure | 0 | 0 |

(Both are slightly below the 8e71fd6 copy taken at 18:55Z — ordinary running costs in between, not the migration.)

- Survival protection: **enabled** (set by the migration).
- A lifecycle pass on the copy: insolvency `died 0, protection true`; estates 0; deliveries 0.
- Custody execution off, no activation; standing identity authority off (no classes, card off); no payment rails;
  sweep policy off; card requests reviewed by the owner above 10,000 (£100); weekly statement Monday 09:00 Europe/London;
  no connectors, orders, card credit or refund requests; registry cap 2 with 2 living. Ledger verify true.
- Afterwards: live schema 45, runtime fda78a0, UI 0.8.4, flags false, only `automaton_fleet` present.

## Cutover command (as run)

```
bash ~/rlc59/fleet-release.sh ~/rlc59/pins.txt 45 59 0.12.0 ~/rlc59/ui-0.12.0-f021673.tgz 9f1742fe071a1c42c97632545741ca01e10746630fdbfcefadc57d387e6db7f0
```

Founders are not upgraded by it; protection is on from the migration. Rollback: `~/rlc59/fleet-rollout.sh revert
~/rlc59/pins.txt 45 59 <reason>` (UI first: `dashboard.env.pre-0.12.0`); see README §3.

## Deployment (2026-10-09, owner-authorized) — DEPLOYED

Pre-flight 22:04Z: pins, package checksum, release scripts and the build checkout matched this record; rehearsal stamp
21:49:54Z (14 min old). Founder baseline taken at 22:04:33Z (`founder-baseline.sh`, read-only).

- `fleet-release.sh` 22:04:47–22:06:31Z, exit 0. Outage 22:05:35–22:06:19Z (44 s). Pre-migration dump
  `~/automaton_fleet-v45-pre-v59-20261009T220555Z.dump` (SHA-256 `c0143688…`); migrate 46–59; reconciliation OK (1,329
  events before, none purged, all preserved). UI 0.12.0 unpacked to `/opt/automaton-fleet/ui/0.12.0`; root, `/login/`
  and `/hq-preview/login/` byte-identical through the public edge; unauthenticated read 401; one `production_deployed`.
- Runtime: `FLEET_RUNTIME_COMMIT=f021673…`, build `0f7c6a6f…1da5`; `/opt/automaton-fleet/current` → the f021673 release.
  Flags: REAL_REPLICATION_ENABLED, REAL_PAYMENTS_ENABLED (runtime and custody), OWNER_SWEEP_ENABLED, FLEET_DRY_RUN_CHILD
  all false. readyz 200 (loopback); public `/readyz` 404 by design.
- Founders: both active, identity hashes unchanged, runtime still `fda78a0`, units running, heartbeats current (22:07:54Z).
  Ledger: verify ok, 752 journals before and after (no posting during the cutover), each founder 20 accounts (17 + 3
  new at zero); only cash and expense non-zero (8,743 + 1,257 and 9,638 + 362 = the 10,000 funding each).
- Events since the baseline: the role grants (x2 each: migration and re-run), `runtime_approved`, `production_deployed`,
  and two `api_auth_failed` heartbeats at 22:06:25Z while the controller restarted (the same pair follows every earlier
  controller restart; none since).
- Read-only checks (README §2 step 5): `hub-custody` off (no activation, 0 rails/signers, both keyless); `hub-paypal` no
  rail; `hub-treasury-health` money states present, cash 18,381 all in agent partitions; `owner-identity-autonomy` OFF;
  `hub-insolvency` rule shown, no deaths, both protected, funded, not exhausted; `hub-storefront` no account; `status`
  cap 2, 2 living, DEVELOPMENT, replication off.
- Evidence (build VM): `~/fleet-release-evidence/f021673/{release.log, founder-baseline-pre.txt, post-cutover-*.txt}`.

Rollback (only if needed, and never once real money or provider data exists): UI `sudo cp -p
/etc/automaton-fleet/dashboard.env.pre-0.12.0 /etc/automaton-fleet/dashboard.env && sudo systemctl restart
automaton-fleet-dashboard.service`; backend `bash ~/rlc59/fleet-rollout.sh revert ~/rlc59/pins.txt 45 59 <reason>`.

## Host change after deployment — custody unit state directory (commit 3f0eae6, owner-authorized, 2026-10-09)

Found when the owner's first PayPal credential upload was refused (`FLEET_CUSTODY_KEY_UNAVAILABLE`): the custody unit
never declared `/var/lib/automaton-fleet-custody`, so under `ProtectSystem=strict` the executor had no state directory,
skipped its sealed vault and published no key (startup log `custodyKey: null`). Present since v49; not caused by f021673.

- Before (22:49:33Z): no state directory, no `custody-x25519.json` anywhere on the disk, 0 published keys (nothing to
  preserve); `REAL_PAYMENTS_ENABLED=false`; custody execution off, 0 activations; live unit sha256 `c3e35575…8dc4`.
- Applied 22:50:48Z: previous unit kept as `/etc/systemd/system/automaton-fleet-custody.service.pre-3f0eae6.bak`;
  `deploy/systemd/automaton-fleet-custody.service` from 3f0eae6 installed (sha256 `a393e2f3…2c63`; adds
  `StateDirectory=automaton-fleet-custody`, `StateDirectoryMode=0700`, `FLEET_CUSTODY_STATE_DIR`, and the v52 Gumroad
  `InaccessiblePaths` line the live unit lacked); `daemon-reload`; custody restarted alone (active, 0 restarts).
- Verified: directory `drwx------ automaton-fleet-custody`; key file `-rw------- automaton-fleet-custody` (not readable by
  the operator account); startup `custodyKey 4fee40f2…`, execution off, no signers; registry `fleet_custody_keys`
  fingerprint `4fee40f2c10ba13908138b8108a0c7efb59cbaa986758b007ce3a2b120bf9d82` equals the key file's public half; one
  `custody_key_published` event. Flags all false; 0 rails; protection on; founders unchanged on fda78a0 and heartbeating;
  controller, dashboard and identity not restarted.
- Rollback (only if needed): reinstall the `.pre-3f0eae6.bak` unit, `daemon-reload`, restart custody (the key file stays;
  credentials sealed to it remain readable once the directory is declared again).
- Evidence (build VM): `~/fleet-release-evidence/custody-unit-3f0eae6/{pre,apply,verify,post}.txt`.
