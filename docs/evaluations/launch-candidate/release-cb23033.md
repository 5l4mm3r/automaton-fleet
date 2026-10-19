# Release cb23033 (schema 95 → 96; UI 0.26.2 unchanged) — the consolidated launch candidate; NOT INSTALLED

## What it contains (from e1c51e2, the running release; 21 commits)
1. **Order and enquiry pages for the service role** (row 23): `svc_repo_requests` / `svc_repo_consent` in the declared
   grants (89ff63b); the controller's startup and readiness audit and the declared list agree; regression tests on the real
   route as `fleet_service_login` (947e36c) and with populated records (c5007ca).
2. **Custody enforces refund authority at dispatch** (row 22, v96, 1236f9b): standing or one-order refund authorities with
   per-refund / 24 h / total maxima and expiry, bound under the authority's lock in the same transaction that hands a refund
   to the worker; the payouts activation no longer releases refunds. **The owner's proof refund never holds the agent's
   cash** (row 21).
3. **Product quality** (fff3b29, 5c35ffd): inspector fleet-qa-3 opens CSV / XLSX in LibreOffice as the customer sees them; a
   product sells publicly only on a current inspector's pass of its current files and while not held; owner hold / release
   of one offer; the independent verdict recorded is the reviewer's own.
4. **Capability guidance from verified state** (449d428): fleet-capability-status v14, Field Guide v2.3, the image tool marked
   not connected.
5. **Fleet Control's AI budget** (d1684f1, made hard in the final commit): each paid call reserves its bounded maximum
   atomically before it is made; unset after install — no paid Fleet Control call until the owner sets it.
6. **Exhaustion, the authoritative measure** (ef968d5, corrected in the final commit): a pending capture never keeps an
   agent alive; verified PayPal-held money always counts; no age rule.
7. **The continued purchase proof** (7161a16; staged separately as `~/rlc106/proof.sh`) and the docs (063e8b4).
8. **Tests** brought up to v95 (69733ed) and to capability status v14 (d5936b6).
9. **Owner corrections, 2026-10-19** (7bb7612): no invented survival grace periods; Fleet Control's budget a hard ceiling,
   unset by default; the concurrent distinct-requests allocation test restored beside the duplicate one.
10. **The services rehearsal's history check** follows the hourly retention it verifies (cb23033; release tooling only — the
    build identity is unchanged).

## Evidence
| Item | Result |
|---|---|
| Pins | commit cb2303342ba242006ef9fd73a64a5b89084ee64f · build faa99a2772c81866ee2ebf088adf8289fd39d69b97b48213480d5351d29b7c1d · lockfile 1df54e35… (unchanged) — **VPS build = local build** (7bb7612 built to the same identity: only a release script differs) |
| Validation | the frozen d5936b6: typecheck clean; 54 targeted suites (419 tests) pass; founder upgrade rehearsal with real processes from e1c51e2 11 passed / 1 skipped (the eea1932-only check). The corrections (7bb7612) re-ran every affected suite: fleet-ledger 28 (concurrent distinct + duplicate), completion-v51 14, spend-review-v64 12 (hard ceiling: unset → no call, too small → refused, reserved max settled ≤ max, two at once → one), v65, r24, lifecycle, clawback, f2-launch, migration paths, static audit, grants, v96 ×2, v77, dashboard e2e, v94, rail readiness — all pass; release tooling 20 |
| Data rehearsal 95 → 96 (VPS) | PASSED 2026-10-19 13:55:46Z (cb23033): migrate-check applies exactly [96] and rolls back; restore row counts identical; reconciliation OK; ledger verifies; re-run a no-op; the dump restores schema 95 with the same ledger head. Live untouched |
| Services rehearsal 95 → 96 (VPS) | PASSED 2026-10-19 13:56:32Z (cb23033): e1c51e2 refuses schema 96; the candidate controller (privileges check included), Operator API and dashboard ready on 96; Fleet Command and history checks pass (none past 7 days before or after the retention pass; it writes no event); ledger head unchanged, no reservation or birth; rollback restores schema 95 with an identical head; e1c51e2 runs again. Production untouched |
| Earlier rehearsal failure | d5936b6's services rehearsal failed 13:10Z on the history check by timing alone (4 routine sign-in copies had just crossed 7 days; production retention is hourly). The check was corrected, not skipped (cb23033). After the failure: no rehearsal unit or database left; production ready, schema 95, both agents paused |
| Production after all rehearsals | e1c51e2, schema 95, ready; both agents paused; the proof order unpaid, checkout open until 2026-10-22 11:04Z; ledger verifies (924 journals); sales, card authority, payouts off; no run budget |

## Install (owner-run, on approval; ends with BOTH AGENTS PAUSED; no paid work; no refund authority granted)
`ssh -t agentfleet-vps 'bash ~/rlc106/install-fix.sh'` — evidence gate (both rehearsals of THIS commit < 24 h), guards
(both paused; no outward release, card authority off, payouts off, sales closed, no run budget; four safety flags false;
schema 95; Agent-2 on b60e262), a fresh baseline dump; the release 95 → 96 (fleet-release.sh; UI 0.26.2 reused); records =
baseline; the founder upgrade rehearsal from e1c51e2 on the host; Agent-1 e1c51e2 → cb23033 with its rollback id; the end
state (no refund authority live; privilege audit clean; readyz ready). Then `bash ~/rlc106/verify-install.sh` (read-only).
No host change beyond the release itself (no new unit, no /etc change).

**Recovery.** Real provider transactions exist (the £1 receiving test, the proof order): **fix forward**; never restore an
old database over them. Within the cutover, any failure after its pre-migration dump rolls back automatically (that dump
holds every transaction up to the cutover). After a successful install: Agent-1's runtime can return to e1c51e2 with
`sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS <upgradeId> <reason>`;
a controller defect is fixed forward with a new release.
