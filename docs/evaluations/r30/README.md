# R30 — controller custody signer: controller + schema v32 (2026-10-02, VPS UTC)

Release `f07261464ec208a11b8d904adf6baa0e9460f47c` (`fleet-origin/f2/integration`). Build
`9bf9ae2241f25d8f97354c9969806b44eb22f60fc6abc9b4edcfc42f1bf66091`, identical locally and on the VPS (`pins.txt`,
`pins-local.txt`); lockfile `eee9dc2f…` unchanged. Design: `docs/design/f2-autonomous-economy.md` §31. Controller-only
update (Founder 1's runtime code is unchanged; it stays on `b949b1c`, untouched).

Evidence (ids, digests, counts, status; scanned clean): `r30-2-rehearsal.txt`, `r30-3-deploy.txt`, `doctor-after.txt`,
`verify-deployment.txt`.

- **R30-2 real-data rehearsal** 11:25:34–11:25:51: dump `~/automaton_fleet-v31-r30-20261002T112538Z.dump` (sha `7a3816d6…`),
  Founder 1 state backup (sha `086d50c5…`, root 0700/0600, credential file excluded); restore 121 tables identical;
  `migrate-check` `{31→32, [32]}`, 0.9 s, audit PASS; ledger head 540 / 503 journals unchanged, Founder 1's 12 accounts
  identical, identity/credential unchanged; Founder 1 `controller_keyless`, 0 self-keyed agents, execution off;
  re-run no-op; rollback proof (schema 31, identical rows/head/identity); throwaway dropped.
- **R30-3 cutover** outage 11:26:43–11:26:55 (12 s, controller-side units only). Pre-v32 dump
  `~/automaton_fleet-v31-pre-v32-20261002T112643Z.dump` (3,910,286 B, sha `d6609eee…8471`, verified); `runtime.env.pre-r30`
  kept (`b949b1c` pins). Audit PASS, runtime approved/VERIFIED, `readyz` 200, custody executor restarted on v32 (no
  signer, execution off). Founder 1 untouched (PID 349284, pin, facts).
- **Doctor after:** DEPLOYMENT OK; `wallet custody` **PASS** (1 living agent keyless, 0 self-keyed); SAFE FOR REAL
  PAYMENTS NO with **1** blocker — no attested live custody signer (live rails and custody execution stay pinned off
  until a reviewed activation). verify-deployment 150/0, including "founder state holds no wallet or private-key file".
- **Rollback:** `runtime.env.pre-r30`; `current` → `releases/b949b1c…`; restore the pre-v32 dump (v31 code refuses v32).
  Founder 1 needs nothing (its runtime is unchanged).
