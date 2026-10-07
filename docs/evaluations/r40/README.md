# R40: schema v45 (V2.4.4 final: disposable notifications, clearable Fleet Command, meaningful Fleet history), PREPARED 2026-10-07

**Candidate**
- Commit `136c4bd72f8ef00cd4556ac33df7a5c3c3f9cf89`
- Build `9823d0a39d61b01b721ee5ede9b99ffd51fa446f33a7cca3a26318ec6676be0a`
- Lockfile `1df54e35…` (unchanged)
- Schema 44 → **45**
- UI **0.8.4 / V2.4.4**: `ui-0.8.4-136c4bd.tgz`, sha256 `35e9350c6cef493c4bf10b6367745b2d0435e50e9e9c12f95d720983fe6d1070`, 105 files.
  Built from `136c4bd`; `artifact.json` names it. Root LIVE digest `c21f2b29…`, `/hq-preview/` digest `1d152474…`.

**Invariant:** every event is meaningful (permanent, in Fleet history) or temporary (hidden, expires).
`fleet_event_in_history` is defined as "has no retention", so there is no third class.

**Rehearsal on a fresh copy of production (20:47Z): PASSED**
- Only migration 45 applied; a re-run applies nothing; ledger verify true; ledger head unchanged.
- **Events before:** 2,868.
- **Purged (by type):**
  - `session_opened` 1,699;
  - `ledger_journal_posted` 526;
  - role grants 140;
  - `notifications_deleted` 7;
  - `runtime_approved` 44;
  - `founder_runtime_upgrade_prepared` 8 and `_committed` 8;
  - `operator_action` 9;
  - `notification` (routine copies) 2;
  - `credential_issued` 1;
  - `genesis_runtime_issued` 1 and `genesis_runtime_evidence` 1.
  - Total 2,446.
- **Events after:** 422 = 2,868 − 2,446, exactly. The canonical digest is byte-identical.
- **On the copy after the migrator and candidate:** 429 events = 69 meaningful history + 353 diagnostics (30 days) + 7
  temporary (7 days: the migrator's 6 role grants and the throwaway approval) + **0 hidden-permanent**.
  - Fleet Command: 34 rows, all P0–P3.
  - Retention pass: nothing expired, no event written.
- **Reconciliation OK:** Agents, cap / population / mode, replication, ledger journals / postings / balances, economics,
  sweeps, Treasury ledger, ventures, missions, knowledge, estates, credentials, and the owner's sign-in digests are all
  unchanged.
- **Rollback proven:** `7f65cd1` refuses 45; the dump restores 44 with the same ledger head, and `7f65cd1`'s controller
  and dashboard run again. Production PIDs were unchanged.
