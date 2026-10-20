# Release 785ffb0 (schema 100 → 101; UI 0.26.2 unchanged) + Agent-1 runtime cb23033 → 785ffb0 — repair A completed; NOT INSTALLED

**Why:** f010dd4 (repair A, release-f010dd4.md) is deployed, but its revision rehearsal in real founder units failed, so
its install stopped before Agent-1 (2026-10-20 00:10Z; both agents paused; the purchase proof unchanged).

## What the rehearsal found (evidence, not inference)
| Defect | Exact cause | How it was established |
|---|---|---|
| LibreOffice made no file in the founder unit (12 attempts; the inspection then rightly refused a missing file) | exit 77 "User installation could not be completed": the unit's DynamicUser has **no passwd entry inside the exec sandbox** (Landlock denies `/run/systemd/userdb/`, so nss-systemd cannot ask systemd), and LibreOffice derives its default profile (`$SYSUSERCONFIG`) from that entry. The earlier unprivileged runs used a real user, which has one | throwaway units confined exactly like the installed template (`~/rlc114/recalc-diagnose.sh`, every [Service] confinement line read from it), the release's own sandbox and the rehearsal's exact command; strace in the unit: `openat("/run/systemd/userdb/") = -1 EACCES`, `getent` none inside, present outside |
| One paid wake after answering the buyer | the two e-mails carrying the founder's own messages finished sending: a finished identity job changes `eventsDigest` (v94) | the rehearsal founder's journal (`founder_event_wake: state changed` 60 s after its turn); the live digest's finished-jobs term |
| Once stuck, a paid turn a minute (12 turns, 15 refusals each) | a turn cut off at its step budget never counted as stalled (`!cutOff`), so it never waited | the founder's journal; fleet-founder-work-continuity 3b reproduces it (105 model calls in 30 idle slots) |

## Change
- Launcher shim: unless the caller names one, `-env:UserInstallation=file://$HOME/.config/libreoffice/4` (where LibreOffice
  would put it for this HOME); a HOME a file URL cannot carry as-is is refused with the reason. **No grant added** (the
  user database stays closed to the sandbox). Covers the agent's commands, the capability probe and the inspector.
- v101 `fleet_agent_attention.eventsDigest`: an identity job that SENT a message (`mail.send` / `sms.send`, succeeded) is
  not news; failed / uncertain / human action still is. `recentEvents` unchanged.
- Founder: a cut-off turn that learned nothing new after its assessment turn waits like any stalled turn (its working
  record carried for when something changes).
- Revision rehearsal: a failed check keeps the founder's last command results; check 2b waits for the closing report.

## Evidence
| Item | Result |
|---|---|
| Pins | commit 785ffb0b8512999889f5bb22778e67b803b5bc61 · build 838234b804945a810441a98b63bf6efd34e2b10c8069cf58cfedef1f5109bba4 · lockfile 1df54e35… — VPS = local |
| Real founder-confined unit, candidate shim | the rehearsal's recalculation rc 0 in 1.5 s; inspection ok: saved values match, displayed dates, page rendered; no seccomp kills |
| New / changed tests | fleet-exec-sandbox (+1 shim profile), fleet-founder-work-continuity (+3b; fails without the fix: 105 vs 15 calls), fleet-v100-obligations-pg (+v101; fails without it) |
| Regression | exec-sandbox, founder runtime (14), step budget, upgrade (12), work continuity, purchase-proof script, qa-inspector-v3, v100 obligations (unit + PG), revision rehearsal phases 1–3, v67 v94 v95 v96 v98 PG — pass. **fleet-v68-wake-lessons-pg 1 failure, pre-existing (fails on e1f02aa), not fixed** |
| Data rehearsal 100 → 101 | PASSED 2026-10-20T00:57:40Z — live untouched |
| Services rehearsal 100 → 101 | PASSED 2026-10-20T00:58:10Z — production untouched (rollback to f010dd4) |
| Founder upgrade rehearsal from cb23033; revision rehearsal (all four phases, real units) | run by install step 3 from the installed release; the install stops before Agent-1's upgrade unless both pass |

## Install (owner-run) — ends with both agents paused; the proof unchanged
`ssh -t agentfleet-vps 'bash ~/rlc115/install.sh'` then `bash ~/rlc115/verify.sh` (read-only). Same steps as f010dd4's
(release 100 → 101; template already installed — checked, not changed; both founder rehearsals; Agent-1 preflight +
upgrade; unit checks + the shim; the proof script pinned; end state with the proof identical).

## Continuation on the existing paid order (a separate approval after the install)
`bash ~/rlc106/proof.sh continue` — the SAME run budget (97.33p left of 200p, ends 2026-10-20 14:33:50Z). If the ceiling
or the end time is reached first, the proof stops (paused, no money-out) and reports what was done; it never restarts.
