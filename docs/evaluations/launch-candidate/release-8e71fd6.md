# Release package — candidate 8e71fd6 (schema 45 → 58, dashboard 0.12.0)

**Superseded by `release-f021673.md` (schema 45 → 59); do not cut over from `~/rlc58`.**

Prepared and rehearsed 2026-10-09; **not deployed**. Production remains `fda78a0`, schema 45, all four safety flags false.

## Identity

| | |
|---|---|
| Release commit | `8e71fd6f4ad1a0fb11ff8b8915be439045d3abda` (`fleet-origin/fleet/final-v2.4`) |
| Runtime build ID | `576c34d5fd6ef6b39f64052b0b9ca5a17687ff62ea0bccd729756872a725feb2` — VPS build and an independent local build agree |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged from production) |
| Pins file (VPS) | `~/rlc58/pins.txt` (the four lines printed by `scripts/fleet-build-runtime.sh`) |
| Dashboard | 0.12.0 — `~/rlc58/ui-0.12.0-8e71fd6.tgz` (VPS), `/var/tmp/automaton-fleet-ui-build/ui-0.12.0-8e71fd6.tgz` (build VM) |
| Dashboard SHA-256 | `9c7474f554c4f59bfcbfaf0df53d401cc578dbfca6653e659cff02f58c4ced79` (verified on the VPS after transfer; live tree digest `6aea44a3…`) |
| Release scripts | `~/rlc58/fleet-{rollout,release,ui-deploy}.sh`, byte-identical to the commit; `~/fleet-rollout.sh` kept for the R41.1 rollback |

## Rehearsal (`fleet-rollout.sh rehearse ~/rlc58/pins.txt 45 58`, 2026-10-09 18:55:22–18:55:43Z) — PASSED

- Production dump `~/automaton_fleet-v45-rollout-8e71fd6-20261009T185527Z.dump`, SHA-256 `8f5c64af…3c29`; restored to a disposable database.
- migrate-check 45 → 58 would apply 46–58; migrate applied; schema 58.
- Privilege audit clean; ledger head unchanged by the migration; ledger verify true.
- Reconciliation OK: 11 new accounts at zero; 740 journals; 1,277 events preserved, none purged; only the role-grant
  events appended.
- Founder 1 identity unchanged; Founder 1 ledger fingerprint unchanged.
- Re-run applies nothing and changes nothing; rollback proof: the dump restores to schema 45 with the same ledger head.
- Stamp `~/rollout-8e71fd6-rehearsal.ok` — the cutover must start before **2026-10-10 18:55:43Z**, or rehearse again.

## Additional checks on a second disposable copy (same dump; dropped afterwards)

| Check | Founder 1 (`01M3F50SH7PNX2E3GST13J52AS`) | Agent 2 (`01M4C4NXT786Q4E9725N5A15KV`) |
|---|---|---|
| Status / identity | active / unchanged | active / unchanged |
| Ledger | 17 accounts unchanged, 3 new at zero | 17 accounts unchanged, 3 new at zero |
| Cash = survival equity (before and after) | 8,765 | 9,660 |
| Wallet measure | funded, spendable 8,765, not exhausted | funded, spendable 9,660, not exhausted |
| Dispute exposure | 0 | 0 |

- Survival protection: **enabled** (set by the migration).
- A lifecycle pass on the copy: insolvency `died 0, protection true`; estates 0; deliveries 0.
- Custody execution off, no activation; standing identity authority off (no classes, card off); no payment rails;
  sweep policy off; card requests reviewed by the owner above 10,000 (£100); weekly statement Monday 09:00 Europe/London;
  no connectors, orders or card credit; registry cap 2 with 2 living.

## Cutover (needs the owner's authorization; runs within the rehearsal window)

```
bash ~/rlc58/fleet-release.sh ~/rlc58/pins.txt 45 58 0.12.0 ~/rlc58/ui-0.12.0-8e71fd6.tgz 9c7474f554c4f59bfcbfaf0df53d401cc578dbfca6653e659cff02f58c4ced79
```

Founders are not upgraded by it; protection is on from the migration. Rollback: `~/rlc58/fleet-rollout.sh revert
~/rlc58/pins.txt 45 58 <reason>` (UI first: `dashboard.env.pre-0.12.0`); see README §3.
