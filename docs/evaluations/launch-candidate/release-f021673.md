# Release package — candidate f021673 (schema 45 → 59, dashboard 0.12.0)

Prepared and rehearsed 2026-10-09; **not deployed**. Production remains `fda78a0`, schema 45, UI 0.8.4, all four safety
flags false. Supersedes `release-8e71fd6.md` (that package lacks v59 and its v58 note fails to apply once v59's wording is in).

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

## Cutover (needs the owner's authorization; runs within the rehearsal window)

```
bash ~/rlc59/fleet-release.sh ~/rlc59/pins.txt 45 59 0.12.0 ~/rlc59/ui-0.12.0-f021673.tgz 9f1742fe071a1c42c97632545741ca01e10746630fdbfcefadc57d387e6db7f0
```

Founders are not upgraded by it; protection is on from the migration. Rollback: `~/rlc59/fleet-rollout.sh revert
~/rlc59/pins.txt 45 59 <reason>` (UI first: `dashboard.env.pre-0.12.0`); see README §3.
