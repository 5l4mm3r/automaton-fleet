# R40: schema v45 (V2.4.4 final: disposable notifications, clearable Fleet Command, meaningful Fleet history), PREPARED 2026-10-07

**Candidate**
- Commit `6fe54b9d09b32743153250018e9530bc5fecf803`
- Build `c06e37cde95ba7085988d3cbbdd93e46b40261a6a227846076e00702781cb4b2`
- Lockfile `1df54e35…` (unchanged)
- Schema 44 → **45**
- UI **0.8.4 / V2.4.4**: `ui-0.8.4-6fe54b9.tgz`, sha256 `37a2f2cc639ee1e5ba3573553092b86ebe17528af9cce2b161dfbb37b0eff2e1`, 105 files
  (root LIVE digest `c21f2b29…`, `/hq-preview/` digest `1d152474…`)

**Rehearsal on a fresh copy of production (20:31Z): PASSED**
- Only migration 45 applied; a re-run applies nothing; ledger verify true; ledger head unchanged.
- **Events before:** 2,866.
- **Purged (by type):**
  - `session_opened` 1,698;
  - `ledger_journal_posted` 525;
  - `agent_role_granted` 33, `service_role_granted` 33, `operator_role_granted` 30, `custody_role_granted` 28,
    `identity_role_granted` 8, `dashboard_role_granted` 8 (140 in total);
  - `notifications_deleted` 7.
  - Total 2,370.
- **Events after:** 496 = 2,866 − 2,370, exactly. The canonical history digest is byte-identical. The migrator then
  appended its 6 role-grant audit records, which expire after 7 days.
- **Copy after the candidate ran:** 34 Fleet Command rows (all P0–P3); 69 history events; 353 diagnostics (30-day
  retention); 0 notifications (the 7 v43 tombstones removed). The retention pass expired nothing and wrote no event.
- **Reconciliation OK:** Agents, population / cap / mode, replication, ledger journals / postings / balances, economics
  and computed sweeps, Treasury ledger, ventures, missions, knowledge, estates, credentials, and the owner's passkeys /
  authenticator / password digests are all unchanged.
- **Rollback proven:** `7f65cd1` refuses schema 45 (class B). The pre-migration dump restores schema 44 with the same
  ledger head, and `7f65cd1`'s controller and dashboard run again. Production PIDs were unchanged during the
  rehearsal.
