# R33 — schemas v34–v38 (identity, economy engine, mail/SMS, browser operator, Admin control centre) — REHEARSED

Release `e9eee6f8ca51575a4d8ec16c841eea2f1c75e598`, build `89533671cd16750fb7a14c70b6d1b5cca2481222c20669d470346f62b55c0094`
(identical locally and on the VPS: `pins.txt`, `pins-local.txt`), lockfile `ea24cb1f…` (new: playwright-core,
@simplewebauthn/server). Supersedes R32 (v34 alone, never cut over).

- **Rehearsal — PASSED** 2026-10-02 16:02:36–16:02:50 UTC with `scripts/fleet-rollout.sh rehearse ~/r33-pins.txt 33 38`
  (`r33-rehearsal.txt`): fresh dump (sha `346253e4…`) + Founder 1 state backup; isolated restore with identical row
  counts; `migrate-check {33→38, [34,35,36,37,38]}`; migrate; privilege audit PASS; ledger head and journal count,
  Founder 1 identity and ledger fingerprint unchanged; ledger verify ok; re-run no-op; rollback proof (the dump restores
  schema 33 with the same head); throwaway dropped; live untouched.
- **Cutover — NOT RUN.** The Claude Code auto-mode classifier denies production deploys from this session
  (`[Production Deploy]`). The owner runs (or approves) exactly:
  `ssh -o BatchMode=yes agentfleet-vps 'bash ~/fleet-rollout.sh cutover ~/r33-pins.txt 33 38'`
  — refuses without this rehearsal (≤ 24 h, same pins); controller-side units only (Founder 1 untouched); automatic
  rollback on any failure (runtime.env.pre-e9eee6f, releases/3aebcc2…, the pre-v38 dump restored).
- After the cutover nothing new runs by itself: the identity broker, browser worker and dashboard are separate,
  not-yet-provisioned services (owner host steps: `docs/design/agent-identity.md`, `deploy/proposed/dashboard/README.md`).
