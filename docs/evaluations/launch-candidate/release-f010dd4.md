# Release f010dd4 (schema 99 → 100; UI 0.26.2 unchanged) + Agent-1 runtime cb23033 → f010dd4 — repair A; CONTROLLER DEPLOYED, AGENT-1 NOT UPGRADED (revision rehearsal failed) — superseded by release-785ffb0.md

**Why (owner, 2026-10-19, after the purchase proof):** the owner's fault report on the paid £5 order (19:13:09Z) was never
answered. Agent-1 was paused at 20:15:32Z with the order, its files, the message, the books and the run budget preserved.

## What was found (evidence, not inference)
| Defect | Exact cause | How it was established |
|---|---|---|
| Seven "bad request" refusals | The arguments were right (`deliverable inspect {paths: [product/Landlord_Compliance_Tracker.xlsx]}`, ± README). The inspector's Python was **killed by the founder unit's system-call filter** on `mbind` (numpy, through openpyxl): no report → the toolbox said FLEET_BAD_REQUEST | the logged argsSha256 of each call reproduced exactly; kernel audit: 11 kills, uid 65037, python3, syscall 237, 19:13–19:15Z; reproduced in a founder-confined unit |
| LibreOffice could not run in the exec sandbox | (1) its control socket goes in /tmp (Landlock: denied; it aborts); (2) its launcher exits when /proc/version is missing (ProcSubset=pid); (3) it reads its shared extension cache in /var/spool/libreoffice (denied: DeploymentException, abort); (4) it chowns its profile file (`chown` killed by the filter) | owner-run diagnosis in confined units; then unprivileged traced runs (strace) of the release's own helper under the founder filter on the production host; LibreOffice source (desktop/unx/source/start.c, sal/osl/unx/pipe.cxx) |
| The buyer's message vanished | customer messages reached the agent only as "since your last turn" events: the next turn's packet no longer had it ("nothing actionable") | mind-log + turn packets |
| The watchdog never stopped | it counted any model call after the buyer message as an answer (23 calls, no reply) | the script's SQL |
| A recalculated workbook would have failed | the inspector compared a saved date (a date) with the engine's day number as text: every date formula "differs" | candidate run on the production host (38 of 38 date cells) |

## Change
- **R1** founder unit: `SystemCallFilter=mbind set_mempolicy get_mempolicy chown fchown fchownat lchown` re-added after
  `~@privileged @resources` (the rest stays denied; ProcSubset=pid, PrivateTmp, PrivateDevices unchanged). Exec sandbox
  (`office`): make-socket + remove in the unit's **private** /tmp (only when mountinfo shows systemd's PrivateTmp — never the
  host's /tmp; nothing can be read, written or created there), /var/spool/libreoffice read-only, the release's launcher shim
  `deploy/sandbox-bin/soffice` (read-only, first on PATH; starts soffice.bin; restarts exit 81). /dev/shm stays closed. The
  capability probe counts a renderer only when it converts. Inspector: saved dates compared as day numbers (fleet-qa-3 kept:
  a correction of a false failure, no new check).
- **R2** an inspector that cannot run → FLEET_PLATFORM_FAULT (never bad request). Every refusal's reason, bounded (300) and
  redacted (e-mails, URLs, tokens, long numbers; record ids kept), in the mind log and the closing note (v100
  `fleet_agent_mind_reports.refusals`, scrubbed again); a platform fault raises AGENT_TOOL_FAULT (AMBER, once a day).
- **R3** v100 `fleet_customer_obligations` (state from the record): an order request is UNANSWERED until an agent message
  after its newest buyer message, then ACKNOWLEDGED until a delivery created after it is sent or `order_message {resolved:
  true}`; an enquiry message is UNANSWERED until a reply. In `fleet_agent_attention.customerObligations`, in every packet
  (essential lines; slim packets too); a sleep is refused while a buyer waits (unless the controller refused the answer); the
  agent's own answer never wakes it (the closing digest re-reads the obligations unless a newer buyer message arrived during
  the turn); the renderer's availability is a free wake signal.
- **R4** proof watchdog: only a message to the buyer answers; the quiet period and the idle-call count start at the resume;
  `continue` resumes the SAME order and run budget (refuses an ended or spent budget: "needs the owner's revised terms").
- **Revision rehearsal** (`sudo fleet-founders.sh revision-rehearsal`): synthetic founder in a real unit (the installed
  template), throwaway registry, the service role (buyer message through `svc_customer_message`), the custody role (capture),
  the identity broker on a simulated shared mailbox, the scripted model: fulfil → the buyer's report with the renderer
  unavailable (a plain sleep refused, acknowledgement, honest blocker update, no model call while waiting or across a restart)
  → renderer back → one wake → recalculate, inspect, review, deliver exactly those bytes → resolved.

## Evidence
| Item | Result |
|---|---|
| Pins | commit f010dd48c4acb2b92e67f1c452421d9c59db096e · build 002c388a2bd16791179ad19222a15f29827ad13968d8fe318da150223de3dc75 · lockfile 1df54e35… — VPS = local |
| New tests | fleet-v100-customer-obligations (6), fleet-v100-obligations-pg (5, incl. the watchdog's own SQL), fleet-v100-revision-rehearsal (phases 1–3, real founder process; this machine has no LibreOffice), fleet-exec-sandbox (+4: grants, private-/tmp detection, shim, template order), fleet-qa-inspector-v3 (+1: dates; fails without the fix), fleet-purchase-proof-script (+1: continue) |
| Regression | 25 runtime suites (328 tests), founder runtime + upgrade (26), v62 v67 v76 v94 v96 v98 PG — pass. **fleet-v68-wake-lessons-pg 1 failure ("a lesson review wakes its proposer") also fails on the committed e1f02aa code: pre-existing, not caused here, not fixed** |
| Production host (unprivileged, no sudo) | candidate helper + filter + shim + inspector on a synthetic workbook: recalculation rc 0 (1.6 s fresh profile, 1.4 s warm), inspection of the recalculated copy pass (saved values match, dates displayed, page rendered), probe renderer ok, renderer-unavailable message; Agent-1's unit mountinfo: /tmp is a systemd-private bind (the grant applies) |
| Data rehearsal 99 → 100 | PASSED 2026-10-19T22:47:03Z — live untouched |
| Services rehearsal 99 → 100 | PASSED 2026-10-19T22:47:38Z — production untouched (rollback to e1f02aa) |
| Founder upgrade rehearsal from cb23033; revision rehearsal (all four phases, real units) | run by install step 3 from the installed release; the install stops before Agent-1's upgrade unless both pass |

## Install (owner-run) — ends with both agents paused; the proof unchanged
`ssh -t agentfleet-vps 'bash ~/rlc113/install.sh'` then `bash ~/rlc113/verify.sh` (read-only). Steps: evidence gate and
baseline → release 99 → 100 → the founder template (only the expected lines; no unit restarted) → both founder rehearsals →
Agent-1 preflight + upgrade (rollback id recorded) → Agent-1's unit checked (office allowances only; setuid / setrlimit /
mount / ptrace still denied) → the proof script pinned → end state: the proof's order, deliveries, messages, run budget
and refunds identical to before the install.

## Continuation on the existing paid order (a separate approval after the install)
`bash ~/rlc106/proof.sh continue` — the SAME run budget (ceiling 200p, 102.67p spent, **97.33p left**, ends
**2026-10-20 14:33:50Z**), no new order, budget, ceiling or end time. Agent-1 then sees the fault report as UNANSWERED; the
watchdog counts 30 minutes from the resume. The proof's calls so far averaged ≈ 3.4p (max ≈ 8.3p): 97p is ≈ 28 average calls.
An answer, the revision and the refund need an estimated 15–25. If the ceiling or the end time is reached first, the proof
stops (paused, budget ended, no money-out) and reports what was done; it never restarts itself.

## Outcome (2026-10-20)
Owner-run install 2026-10-19 23:37–00:10Z: release deployed 23:38:54Z (schema 100, outage 45 s, reconciliation OK), the
founder template installed (no unit restarted), the founder upgrade rehearsal from cb23033 passed (27/27). The revision
rehearsal in real founder units FAILED (10 of 14): phase 3 — one paid wake after the answer (its own e-mails finishing);
phase 4 — LibreOffice exit 77 in the unit (no passwd entry for the DynamicUser inside the sandbox), and the stuck founder
then took a paid turn a minute. The install stopped as designed before Agent-1: both agents paused, Agent-1 on cb23033,
the proof unchanged. Corrected in 785ffb0 (release-785ffb0.md).
