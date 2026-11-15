# R31 — constitutional correction: controller + schema v33 (2026-10-02, VPS UTC)

Release `3aebcc22107a0dfebe9123f58df004ccdc1d155b`, build `055e80765edf48186f1a7076c4687a77f05b2175e6ab3f6bf9dca6aabfe01729`
(identical locally and on the VPS), lockfile `eee9dc2f…` unchanged. Controller-only (Founder 1 untouched on `b949b1c`).
Design: `docs/design/f2-autonomous-economy.md` §32; audit: `docs/design/autonomy-permission-audit.md`.

- **R31-2 rehearsal** 12:04:13–12:04:31: dump `~/automaton_fleet-v32-r31-20261002T120418Z.dump` (sha `2bb2a486…`), Founder 1
  state backup (sha `443806cd…`); restore 123 tables identical; `migrate-check` `{32→33, [33]}`, audit PASS; ledger head
  540 / 503 journals and Founder 1's 12 accounts identical; identity/credential unchanged; Founder 1 keyless; tax
  fallback 0, a sale without a profile reserves 0, rail entity nullable; re-run no-op; rollback proof; throwaway dropped.
- **R31-3 cutover** 12:05:18–12:05:29 (11 s, controller-side units). Pre-v33 dump
  `~/automaton_fleet-v32-pre-v33-20261002T120518Z.dump` (sha `39658635…de3`, verified); `runtime.env.pre-r31` kept
  (`f072614` pins). Audit PASS, runtime VERIFIED, `readyz` 200; doctor DEPLOYMENT OK, wallet custody PASS, SAFE FOR REAL
  PAYMENTS NO (1 blocker: no attested live custody signer); verify-deployment 150/0; flags false.
- **Rollback:** `runtime.env.pre-r31`; `current` → `releases/f072614…`; restore the pre-v33 dump.
