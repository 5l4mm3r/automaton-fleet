# R29 — F2 autonomous economy: controller + schema v26–v31, Founder 1 (2026-10-02, VPS UTC)

Release `b949b1c7f156ac73ac12c31cbc3eeb958413169e` (`fleet-origin/f2/integration`, contains the frozen F2 candidate
`713f4dd`). Build `2b9584d5f73b87552e8d672feb2b90b1ef10419c00c603e7f46f084739e10da2`, identical locally and on the VPS
(`pins.txt`, `pins-local.txt`). Lockfile `eee9dc2f…` unchanged. Procedure and record: runbook "Stage R29".

Evidence (ids, digests, counts and status only; scanned clean; no founder-written text):

| File | Content |
|---|---|
| `doctor-before.txt`, `doctor-after.txt` | doctor at R29-0 and after R29-3 |
| `r29-2-rehearsal.txt` | backup, isolated restore, real-data v25→v31 rehearsal, idempotency, rollback proof |
| `r29-3-deploy.txt` | controller + schema cutover (12 s outage) and post-checks |
| `rehearsal.json` | Founder upgrade host rehearsal (24/24) |
| `f1-preflight.json`, `f1-upgrade.json` | Founder 1 preflight and upgrade receipt `8b85e001-…` |
| `f1-before.txt`, `f1-after.txt` | Founder 1 identity / books / state digests around the upgrade |

Summary: schema 31 in production; ledger head and journals unchanged by the migration; Founder 1 the same economic
actor (identity, credential, Genesis, ledger, durable state identical) on `b949b1c` with the economy tools; its first
wake selected a venture itself, with no owner step. Real payments, owner sweeps, replication and the dry-run child
remain off; rails none; Treasury unallocated 0.
