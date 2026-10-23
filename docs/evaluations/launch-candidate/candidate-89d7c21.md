# Candidate 89d7c21 — frozen, installed BESIDE production, rehearsed (2026-10-23); NOT deployed

Pins (built twice on the VPS, both verified identical): commit 89d7c21be73641f08fd99cbb35abb21f0e91af6e · build
6876e356e58db201e095a79c56b85a3eacfeb33a1759ba072501004eb2af66c0 · lockfile 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1.
Schema 110 → 111 (v111). Kit: ~/rlc130 (pins.txt, logs, baselines, terms-planB.json).
Installed at /opt/automaton-fleet/releases/89d7c21… (root-owned, read-only, identity re-verified); `current` unchanged (b576ae0).

| Rehearsal (scripted / non-billable) | Result | Log |
|---|---|---|
| Data: fresh read-only dump → throwaway DB, 110 → 111, ledger verify, re-run no-op, rollback proof | PASSED 2026-10-23T00:38:41Z — live untouched (schema 110) | rehearse.log |
| Services: candidate controller / Operator API / dashboard on 111; b576ae0 refuses 111; DROP + restore; b576ae0 ready again | PASSED 00:39:19Z — ledger head identical (1176), production PIDs unchanged | upgrade-rehearsal.log |
| Founder upgrade from b576ae0 (synthetic founder, real unit, fake Messages API) | 27/27 — production unchanged, host clean, living founders untouched | founder-upgrade-rehearsal.log |
| Revision (buyer's revision end to end, real unit; renderer phase ran; continuity 5a–5e) | 19/19, complete — production unchanged, living founders untouched | revision-rehearsal.log |

End state = baseline (baseline-before.txt vs baseline-after.txt, diff empty): current b576ae0, schema 110, Agent-1 b576ae0
paused (pid 1745296), Agent-2 b60e262 paused (pid 866408), ledger verifies, provider credit 2,924,782,970 µ¢ unchanged, the four
safety flags false; only the two living founder units exist. No migration, cutover, posting, authority, credit hold or model call.

Rollback evidence for a later install: the data rehearsal's rollback proof (the dump restores to 110 with the same ledger head)
and the services rehearsal's exact cutover rollback (DROP + restore → identical ledger head → b576ae0 serving again).

Plan B frozen terms: ~/rlc130/terms-planB.json (sha256 77eed3283e3869fccf25234bb71cbcea0db5c09edcf1f6bc2d5f6fcafeaeb947), run
scen-89d7c21-b1, ceiling 1,200p all-in, credit hold 1,337,536,449 µ¢ ($13.38) — NOT placed.
Open before launch: outbox lessons of a DEAD agent are not harvested (teardown deletes the state without reading the outbox).

## INSTALLED 2026-10-23T01:35:34Z (owner approval: install, both agents paused; option 2 — no automatic database restore)
- Kit ~/rlc130/install.sh (made from rlc129's by counted edits) ran fleet-release.sh with FLEET_ROLLOUT_NO_AUTO_RESTORE=1 and the
  kit's fleet-rollout.sh (+17 lines, nothing removed): past the migration point a failure stops the controller-side units and
  restores NOTHING (no DROP/pg_restore, no re-point to b576ae0, nothing started); `revert` refuses and stops the units. Stub
  tests before the run: rollback (migrated, flag) → exit 2, only `systemctl stop`; without the flag the restore is attempted
  (sensitivity); before the migration point the original path (no data restore); the real script's revert → exit 3, only the
  stop + one read; no trap or other restore in fleet-release.sh, fleet-ui-deploy.sh or install.sh (`pg_restore -l` lists only).
- Outage 01:34:41–01:35:26Z (45 s); reconciliation OK (3,899 events preserved); production_deployed recorded; UI 0.26.2 reused.
- Agent-1 b576ae0 → 89d7c21, upgradeId 4bc9e5f2-3d08-4413-99a9-166266562f0d (rollback:
  sudo /opt/automaton-fleet/current/scripts/fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS 4bc9e5f2-3d08-4413-99a9-166266562f0d <reason>).
- verify.sh: VERIFIED 01:36:00Z, 69 checks. State (installed-state.txt): current 89d7c21, schema 111, Agent-1 89d7c21 paused
  (pid 1866135), Agent-2 b60e262 paused (pid 866408, unchanged), ledger verifies, provider credit 2,924,782,970 µ¢, held 0, the four
  flags false. No credit hold, engineering call, cost exception or unresolved reservation.
- Plan B terms refreshed 01:36:11Z (terms-planB.json sha256 d5d60c10…): FX 747613, lot 05f4cb13 (4955 / 4129000000), credit
  unchanged → ceiling 1,200p, hold 1,337,536,449 µ¢ ($13.38). Hold NOT placed; the paid run awaits the owner's explicit approval.
- Open before launch: teardown must not delete a dead agent's unharvested candidate-lesson outbox (to be fixed in the next build).

## Plan B paid scenario run scen-89d7c21-b1 (owner approval 2026-10-23)

- Hold 1,337,536,449 µ¢ placed 01:46:40Z; suite 01:46:59Z → 04:05:12Z on 89d7c21 (terms sha256 f60b8522…, ceiling 1,200p, one attempt
  each, all Opus T3). Evidence: /var/lib/automaton-fleet-eval/scen-89d7c21-b1 (root 0600; no key in it); call files + SHA256SUMS in ~/rlc130/calls.
- Spend: 87 sent calls (86 usage-billed; 1 rejected by the provider with no charge, S3 02:37:01Z, req_011CgJPeozzhzNusYBQpYmWe),
  113 refused unsent by the harness ceiling — 200 records; $5.272836 credit =
  473.064082p all-in. Imported once (200 rows, 0 duplicates, totals equal the report); no cost exception, no unresolved reservation;
  hold released (imported 527,283,600 µ¢). Correction: the release note recorded on the hold says "85 usage, 1 no-charge error,
  114 refused" — the records show 86 / 1 / 113 (the note is text only; every amount is from the rows). Credit 2,924,782,970 → 2,397,499,370 µ¢, held 0. Agents paused, pids unchanged, flags false.

| Scenario | Verdict | All-in p | Sent / refused | What it did | Stop |
|---|---|---|---|---|---|
| S1 order + correction (300p) | incomplete | 220.72 | 49 / 30 | delivered the PDF (review pass) in 8 min; answered the correction in 5.5 min; built + inspected the revision (pass) | starved 02:02Z: room < one worst case |
| S2 two SIGKILLs (250p) | infrastructure | 31.98 | 2 / 0 | was working the order | harness: `systemctl kill` exit ≠ 0 (founder killed; sandbox aux processes refused SIGKILL) |
| S3 blanks / contradiction / blocked (200p) | incomplete | 117.59 | 26 / 38 | delivered the workbook (review pass), unchanged | starved 02:38Z before A's question; B and C never ran meaningfully |
| S4 economical sleep (100p) | incomplete | 31.78 | 2 / 45 | read goals, field guide, knowledge | starved after 2 calls |
| S5 lesson application (150p) | poor_decision | 49.48 | 5 / 0 | quoted £39 for a bespoke 30-page guide, well written | did not consult shared knowledge |
| S6 opportunity choice (200p) | completed | 21.51 | 3 / 0 | chose the evidenced option B, measurable criterion | done |

Findings (harness, not model): (1) the meter reserves each call's worst case (16k output + byte-bound input ≈ 79–89p) while calls cost
3–20p, so a scenario can use only ≈ cap − 85p and S4 (100p) was unrunnable; (2) killHard must accept systemctl kill's non-zero exit when
the main process died. Runtime finding: in S1 nearly every turn ended FLEET_TURN_CONTEXT_BUDGET right after view_image (2–9 steps per
turn, a new full packet each minute). S1/S3/S4 say nothing yet about judgment; S5 is a genuine miss; S6 a genuine pass.

### Interpretation (owner, 2026-10-23) and the repair batch

S1: delivery and acknowledgement worked; the revised delivery is unproven. S2: invalidated by the harness's reading of the kill.
S3: valid blanks kept (A) — B and C untested. S4: no evidence. S5: a real gap — relevant evidence ignored (the price alone proves
nothing: a different scope can justify one). S6: passed within the supplied exercise. S6 and S3-A carry forward.

Repairs (scripted checks only; no paid call):
1. **Budget.** The worst case is honest — bytes ≥ tokens, the whole prompt at the cache-write price (no cache hit can be
   assumed), the full 16,000-token output allowance (production's; observed max 4,183 incl. thinking) — so production's
   request limits are kept and the caps are sized instead: measured spend + one worst-case reservation (95p). Not honest was
   the image: the meter counted its base64 as text (it never mattered in b1: no image step was ever sent, see 3). Now each
   image is bound by its own pixels — max(1,600, ⌈w·h/750⌉), read from the header — in the controller's reservation and the
   meter alike. The meter now reports EXHAUSTED once no call can fit (two refusals in a row with nothing sent between, or a
   refusal leaving less than the smallest worst case seen); the suite ends the scenario there as incomplete, with the
   progress it had made (b1: 113 refusals retried once a minute until the time limit).
2. **S2.** The kill reads the unit's MainPID first and succeeds once that process is gone; systemctl's error about auxiliary
   processes is recorded with the kill. Pass: two kills, recovery, exactly one delivery, no message repeated.
3. **Images / context.** Cause, measured from S1's evidence: 10 of the 11 cut turns ended on the view_image result itself — the
   turn budget (40 KB) counted the image's base64 as text, while the conversation had grown by only ~0.3k–6.7k tokens. The
   model saw none of its 10 images and re-rendered each turn. Now an image counts as its token bound (×4 bytes): every S1
   image turn would have stayed within the unchanged 40 KB. Second fault found on the way: the controller read every
   cognition request at 64 KB, so no image could ever reach the model; an accepted session may now send up to the
   economy's 21 MiB (images stay bounded by validateMessages: ≤ 2 per tool result, ≤ ~1.9 MB base64 each).
4. **S5.** An enquiry read now carries the matching library entries and shared lessons (≤ 3 each, with date and source),
   searched by the offer and brief, with the instruction to judge which apply — evidence to weigh, never a rule, no new
   block. S5 now passes when the agent's own record uses that evidence (a figure or source from it); a price outside
   £7–£12 that does so passes and is flagged for the owner's reading.

Tests: fleet-eval-repairs (10), fleet-founder-work-continuity 1k (a 300 KB render is seen in the next step), fleet-witness (cognition
body limit: 403 by scope once accepted, refused at 64 KB before), fleet-eval-cost-meter, fleet-money-checks, fleet-v79-vision-tools,
fleet-cognition-routing, fleet-founder-events-overflow, fleet-eval-scenario-suite dry run (fake provider, real founder): 1p cap now
ends at its first refusal. Pre-existing, unchanged: an unhandled rejection in work-continuity 1j's scripted provider (also on HEAD).

Completion checks (owner review, 2026-10-23), free, through the real path (founder process → FleetService → routed gateway →
metered Anthropic client → loopback Messages API with a scripted model): fleet-eval-s2-image-e2e — two real SIGKILLs (killMainProcess,
pids 108414 / 108513), recovery after each, exactly one delivery (review pass), the buyer message sent once (12:19:20), none
repeated; the founder's rendered page (1240 × 1754 PNG) reached the model as a valid image block, no protocol violation. The
kill fell before the delivery call; a completed external action not repeated after a mid-turn kill is work-continuity 1j.
Image headers: the controller now refuses an image whose header is unreadable or not the type it is labelled (validateMessages;
view_image says so with the fix), so every image sent has a known pixel size — the bound no longer rests on the provider
refusing it; an unreadable one would be bounded as the API's largest (8000², 85,334 tokens). The fake Messages API checks image
blocks as the real one and records them. Pre-existing, unchanged: fleet-routing-verify expects 35 tools, the toolset has 36
(fails identically on HEAD).

S1's starting point: the initial phase stays. A faithful correction-stage fixture would need the agent's own build files (b1's
workspace was torn down; only hashes remain), a passing review bound to bytes its own inspector checked (fabricating one would
bypass the check being tested) and its own memory of the delivery; without them the test becomes an edit of someone else's PDF,
not continuity of its own work — where b1 failed. Cost: ~115p of S1's 360p cap. Expected spend 655p = S1 260.7 (114.5 + 106.2 +
~40 send) + S2 145 + S3 125 + S4 75 + S5 49.5; without S1's send allowance, 615p.

### Plan C — targeted demonstrations (proposed; NOT approved, nothing placed)

Run against the NEW candidate installed beside production (no cutover; Agent-1/2 paused and unchanged); `--only s1,s2,s3,s4,s5`.

| Demonstration | Cap | Basis (b1 measured) | Time |
|---|---|---|---|
| S1 correction through the revised delivery | 360p | 114.5p to first delivery + 106.2p correction phase + ~40p send | 45 min |
| S2 two kills, recovery, no duplicate | 250p | ~115p delivery + ~30p restarts | 45 min |
| S3 B (contradicting inspector) + C (no renderer); A carried | 220p | ~80p B + ~30p C + ~15p orientation | 45 min |
| S4 economical sleep, then wake | 170p | ~45p settle + ~30p answer | 45 min |
| S5 knowledge application (repaired) | 150p | 49.5p in b1 | 30 min |

Each cap includes one 95p worst-case reservation, never spent unless used. Ceiling 1,150p all-in; hold 1,281,805,763 µ¢ ($12.82)
at FX 747613 / lot 05f4cb13 (re-read at run time); expected spend ~655p. One attempt each; no reruns or budget increases.
