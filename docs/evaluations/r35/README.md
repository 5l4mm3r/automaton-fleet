# R35 — schemas v34–v41 (R34 + communications ready but dormant) — REHEARSED

Release `f4be395393d332b1bc35d25c07603f571d1182f3`, build `c088aa58ff257ec45e364d92a9d718436c535ffbd896442c6a62ed71c7cb7728`,
lockfile `1df54e35…` (adds imapflow 2.2.1, nodemailer 10.0.13, mailparser 3.9.33 for the dormant Proton Bridge adapter).
The build is identical locally and on the VPS (`pins-local.txt`, `pins.txt`). **Supersedes R34** (`8fa10bf`): the
communications architecture changed after R34, so R34 must not be cut over. R33 is superseded too.

- **Clean aggregate run** (local, sequential): typecheck PASS, `pnpm build` PASS, `vitest run` 138 files, 2760 passed,
  1 skipped, **0 failed, 0 timed out**.
  - The first attempt had two real failures, both fixed and then fully re-run:
    1. a reveal column named `secret_name` broke the "no secret columns" schema policy; it was renamed to `provider_name`.
    2. the dev VM's disk was at 95% from leftover ephemeral test clusters, which failed the doctor's log-disk check;
       those clusters were cleaned up.
- **Rehearsal — PASSED** 2026-10-02 19:02:43–19:02:55 UTC, `fleet-rollout.sh rehearse ~/r35-pins.txt 33 41`
  (`r35-rehearsal.txt`). Steps and results:
  - fresh dump (sha `68c750c2…`), restore row counts identical;
  - `migrate-check {33→41, [34..41]}`, migrate;
  - privilege audit PASS; Founder 1 identity and ledger fingerprint unchanged (fail-closed checks); ledger verify ok;
  - re-run no-op; rollback proof (the dump restores schema 33 with the same head); live untouched.
- **Cutover — NOT RUN** (the environment denies production deploys from Claude Code). The owner runs exactly:
  `ssh -o BatchMode=yes agentfleet-vps 'bash ~/fleet-rollout.sh cutover ~/r35-pins.txt 33 41'`
  (needs a rehearsal from the last 24 h: re-rehearse after 2026-10-03 19:02Z).
- After the cutover, mail and SMS stay **NOT CONFIGURED**: no broker provider is set and nothing is paid. Activation
  briefs: `deploy/proposed/proton-bridge/README.md`, `deploy/proposed/twilio/README.md`.
