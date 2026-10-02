# R34 — schemas v34–v40 (R33 + v39 replication accounting, the Next.js control centre, v40 birth provisioning) — REHEARSED

Release `8fa10bfbef0b1d9fe7f0ed26f373597cbd4096e6`, build `3a1c603c11a3775e6f2360cb4ede140010a416ed4cef0259175361fe2ef11293`,
lockfile `b3dbacde…` (adds Next 16 / React 19 / Tailwind v4 for `packages/dashboard-web`). The build is identical
locally and on the VPS (`pins-local.txt`, `pins.txt`). The build identity now includes the dashboard static export
(`packages/dashboard-web/out`). **Supersedes R33** (`e9eee6f`, which ships the vanilla UI the owner ruled must not be
deployed): do not cut R33 over.

- **Clean aggregate run** (local, sequential, no parallel builds): typecheck PASS, `pnpm build` PASS, `vitest run`
  136 files, 2742 passed, 1 skipped, **0 failed, 0 timed out**.
- **Cross-host reproducibility**: a per-file comparison of `dist/` and `out/` (1401 files) was byte-identical. The first
  VPS build printed a different ID only because the VPS build checkout (`~/automaton-fleet-build`) was still at
  `3aebcc2`, whose identity code predates the optional export dir. With the checkout moved to `8fa10bf`, the pins
  match. **Rule:** the build checkout must be at the candidate commit whenever the identity rules change.
- **Rehearsal — PASSED** 2026-10-02 17:36:04–17:36:19 UTC, `fleet-rollout.sh rehearse ~/r34-pins.txt 33 40`
  (`r34-rehearsal.txt`). Steps: fresh dump (sha `9c970f09…`) and Founder 1 state backup; isolated restore with
  identical row counts; `migrate-check {33→40, [34..40]}`; migrate. The privilege audit passed. Ledger head, Founder 1
  identity and ledger fingerprint were unchanged (fail-closed checks), and ledger verify was ok. The re-run was a
  no-op. Rollback proof: the dump restores schema 33 with the same head. The throwaway database was dropped and live
  was untouched.
- **Cutover — NOT RUN** (the environment denies production deploys from Claude Code). The owner runs exactly:
  `ssh -o BatchMode=yes agentfleet-vps 'bash ~/fleet-rollout.sh cutover ~/r34-pins.txt 33 40'`
  It refuses without this rehearsal (≤ 24 h, same pins; re-rehearse after 2026-10-03 17:36Z). It touches
  controller-side units only (Founder 1 is untouched) and rolls back automatically on any failure.
- After the cutover: Founder 1 stays on `b949b1c` until `fleet-founders.sh upgrade-runtime`. The broker, browser worker
  and dashboard are still separate, unprovisioned services. A manual birth becomes possible
  (`economy-birth` → `fleet-founders.sh birth <orderId>`), within cap 2 (1 living + 1).
