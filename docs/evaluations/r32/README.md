# R32 — agent operational identity + owner identity broker: controller + schema v34 (2026-10-02, VPS UTC)

Release `27b07e90baccbbb263440b3d8d77d5c040ff1b98`, build `1c430ef8ebec0ec72b25b6bd35eee2a4a3e3c04dcfcfbf48424eafbd60c60ba4`
(identical locally and on the VPS: `pins.txt`, `pins-local.txt`), lockfile `eee9dc2f…` unchanged. Controller-only.
Design: `docs/design/agent-identity.md`, `docs/design/f2-autonomous-economy.md` §33.

- **R32-2 rehearsal — PASSED** 12:42:40–12:42:58: dump `~/automaton_fleet-v33-r32-20261002T124245Z.dump`
  (sha `572132f6…`), Founder 1 state backup (sha `e5759876…`); restore 123 tables identical; `migrate-check`
  `{33→34, [34]}`, migrate 986 ms, audit PASS (broker role not provisioned → accepted); ledger head 540 / 503 journals
  and Founder 1's 12 accounts identical; identity/credential unchanged; Founder 1 keyless, custody execution off; v33
  preserved (tax fallback 0, entity nullable); v34: 9 new tables, empty identity status, 0 v11 facts held, raw-release
  functions retired, `fleet_org_identity_set` → `FLEET_OWNER_VAULT`; only `fleet_events` (+4) and the migration row
  changed; re-run no-op; rollback proof to schema 33; throwaway dropped; live untouched.
- **R32-3 cutover — NOT RUN.** The Claude Code auto-mode classifier denied the production cutover command. Production
  remains on `3aebcc2`, schema 33 (verified read-only afterwards; no `runtime.env.pre-r32`, nothing staged).
  `r32-3-deploy.sh` is the exact, fail-closed script (derived from R31-3) for the owner to run or approve.
- **Rollback (after a cutover):** `runtime.env.pre-r32`; `current` → `releases/3aebcc2…`; restore the pre-v34 dump.
