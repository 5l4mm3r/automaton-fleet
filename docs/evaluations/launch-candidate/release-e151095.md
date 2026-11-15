# Release e151095 (schema 109 → 110; UI 0.26.2 unchanged; controller only) — PREPARED, NOT INSTALLED

Order closure applies to the closed order's conversation, not to the buyer's address (owner, 2026-10-21: "Closing one order
should not prevent that customer from contacting Agent-1 about a new enquiry"), replacing v109's address-wide diversion
(a defect found before the workbook/email check: the owner's Gmail, buyer of the refunded £5 order, could never reach
Agent-1). Also: Fleet Control's AI budget can be cleared (the card proof's bounded review budget, set and cleared by
launch-checks.sh card).

| Item | Result |
|---|---|
| Pins | commit e1510950632e45d80b1efe55204bbdfdb7ca5661 · build 19ace8198528e17d08be5d1aeaab6e8b41fe67f84b45ab86793b23f11fd9b927 · lockfile 1df54e35… |
| Routing | 1 linked thread reply: open order → joins it; closed → kept for the owner (P2). 2 no reliable link but it points at a closed order (page link / reference / subject of the agent's mail about it) → kept for the owner, marked ambiguous; never joins another order, never reopens. 3 the buyer's only open order. 4 otherwise a new enquiry → the agent's ordinary mail |
| Tests | fleet-v108-completion-pg 7/7 (closed-order reply, new enquiry from the same address, ambiguous by subject and by reference, open second order); fleet-spend-review-v64-pg 12/12 (budget clear: owner only, reason, back to unset); fleet-launch-checks-script 3/3; v96 refund, v96 public routes, v97 journey, v63 mail, v88 (privilege audit) 26/26; tsc clean |
| Rehearsals 109 → 110 | data PASSED 2026-10-21 04:46:40Z; services PASSED 04:47:10Z — live untouched (schema 109) |
| Kit | ~/rlc127/install.sh, verify.sh (v109 checks follow the keep-for-owner text into fleet_mail_keep_for_owner; one v110 check; Agent-2's rollback build present) |
| Install | awaiting the owner's approval: `ssh -t agentfleet-vps 'bash ~/rlc127/install.sh'` then `bash ~/rlc127/verify.sh`. Agent-1 stays on a0bbf4e, Agent-2 on b60e262, both paused; nothing opened |

Separately (no release): Agent-2's rollback build 973e0c1 (deleted in the 2026-10-21 disk cleanup) restored 04:39:40Z from
the exact commit, frozen lockfile, verified against upgrade b4548dbd's recorded build 77284506a0d3… — root-owned, read-only,
`current` unchanged, Agent-2 not restarted.
