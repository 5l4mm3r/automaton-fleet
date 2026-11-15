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

## Re-rehearsal — 2026-10-03 (the first window was expiring)

- **Production verified read-only first (18:52Z):**
  - controller `3aebcc2` (build `055e8076…`), schema 33;
  - ledger verify ok (503 journals, 0 unbalanced, head `1d3e56f7…`);
  - Founder 1 active, not held, on `b949b1c`;
  - registry cap 2, DEVELOPMENT, replication off;
  - REAL_PAYMENTS / OWNER_SWEEP / REAL_REPLICATION / DRY_RUN_CHILD false;
  - controller ready; public healthz 200.
- **Build identity re-verified:** a from-scratch VPS rebuild of `f4be395` (build checkout at `f4be395`, rollout script
  identical to the commit's) gave exactly `c088aa58…` / `1df54e35…`, equal to `~/r35-pins.txt` and `pins-local.txt`.
- **Rehearsal PASSED 2026-10-03 18:53:48–18:53:59Z** (`r35-rehearsal-2026-10-03.txt`):
  - fresh dump (sha `5c249c44…`), restore row counts identical;
  - migrate-check 33→41 [34..41], migrate;
  - privilege audit PASS; Founder 1 identity and books unchanged (fail-closed checks); ledger verify ok;
  - re-run a no-op; rollback proof (the dump restores schema 33 with the same head);
  - live re-read afterwards unchanged (schema 33, same ledger head).
  - Valid for a cutover until 2026-10-04 18:53Z.
- The Codex dashboard commits (`4fa02a4`, `27ea168`) change no runtime file: R35 is still `f4be395`.

## Cutover — DEPLOYED 2026-10-03 18:56:42–18:57:43Z (run by the owner); verified read-only 18:59Z

- **Rollout log** (`r35-cutover.txt`):
  - the verified build `c088aa58…` was staged and installed;
  - outage 18:57:25–18:57:38Z (13 s), with a pre-migration dump (`automaton_fleet-v33-pre-v41-20261003T185725Z.dump`,
    sha `a7171197…`);
  - migrate 33→41; doctor DEPLOYMENT OK, SAFE FOR DRY RUN YES, real replication / payments NO (as intended);
  - `DEPLOYED … schema 41, readyz 200`; no rollback.
  - Rollback point: `runtime.env.pre-f4be395`, `releases/3aebcc2`, that dump.
- **Runtime:**
  - runtime.env pins `f4be395` / `c088aa58…` / `1df54e35…`; `current` → `releases/f4be395…`;
  - the controller process runs from that release (started 18:57:36Z, 0 restarts);
  - the installed release's own build identity recomputes to `c088aa58…` / `1df54e35…`;
  - no process runs from `3aebcc2`; readyz: schema v41, release `f4be395`, privileges ok; public healthz 200.
- **Database:**
  - migrations 34–41 applied; ledger verify ok, with the same head `1d3e56f7…` and 503 journals as before the cutover
    (no money moved);
  - Treasury cash 0, owner contributed £100.00, Fleet-generated 0 (the whole Genesis capital is Founder 1's);
  - registry cap 2, DEVELOPMENT mode, replication off; counters consistent (1 living).
- **Founder 1:**
  - same process (since 2026-10-02 10:44Z, 0 restarts), still on `b949b1c`, active, not held, heartbeat fresh;
  - books identical to the pre-cutover fingerprint (cash 9,125, expense 875, 502 journals, last seq 540).
- **Absent, as intended:**
  - automatic birth orders and birth cohorts: none;
  - mail / SMS providers, numbers, provider secrets: none (MAIL and SMS NOT CONFIGURED);
  - flags: REAL_PAYMENTS / OWNER_SWEEP / REAL_REPLICATION / DRY_RUN_CHILD false;
  - not yet provisioned: identity, dashboard and browser roles and services.
