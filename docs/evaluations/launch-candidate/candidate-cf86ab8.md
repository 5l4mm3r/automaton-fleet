# Candidate cf86ab8 — frozen, installed BESIDE production, rehearsed (2026-10-23); NOT deployed

The repairs after paid run scen-89d7c21-b1 (record: candidate-89d7c21.md): images reach the model and are bounded by their
pixels; unreadable/mislabelled images refused; the harness ends a scenario when no call fits; S2's kill judged by the main
process; S3 parts; knowledge beside the buyer's request; S5 judges engagement. Code only: schema 111 unchanged.

Pins (built on the VPS from the operator checkout): commit cf86ab8c0ca2a14267cdd44ef873e79af2387427 · build
b68fc59893be1cf71e69691e9ce475fbfbdaf06fcd69c5fe21e71c27347dad79 · lockfile 1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1.
Installed at /opt/automaton-fleet/releases/cf86ab8… (root-owned, read-only, identity re-verified); `current` unchanged (89d7c21).
Kit: ~/rlc131 (pins.txt, build/stage/side-install logs, rehearsal logs, baselines, terms-planC.json).

| Rehearsal (free: scripted / throwaway) | Result |
|---|---|
| data (rollout rehearse 111 → 111) | PASSED 12:25:33Z — live untouched; the dump restores schema 111 with the same ledger head |
| services (upgrade rehearsal 111 → 111) | PASSED 12:26:08Z — code-only rollback to 89d7c21 keeps every candidate-era write; production PIDs unchanged |
| founder upgrade (89d7c21 → cf86ab8) | 27 / 27, pass, living founders untouched |
| revision | 19 / 19, pass, living founders untouched |

Before / after (12:23Z / 12:52Z, read-only): current 89d7c21, schema 111, ledger head 1176 e214852e…, verify true; Agent-1 89d7c21
pid 1866135 and Agent-2 b60e262 pid 866408 both paused; cap 2 DEVELOPMENT; credit 2,397,499,370 µ¢, held 0. Events 3943 → 3938:
the routine retention pass (temporary events older than their 30 days; the oldest remaining is 2026-09-23 22:24Z); no permanent
event removed.

Plan C terms (read-only from production 12:52:27Z; ~/rlc131/terms-planC.json sha256 fdf67ead…): run scen-cf86ab8-c1, FX 747613, lot
05f4cb13 (4955 / 4129000000), tiers T1 haiku-4-5 2,000 · T2 sonnet-5-5 8,000 · T3 opus-5-5 16,000; caps S1 360 · S2 250 · S3 220
(parts B, C) · S4 170 · S5 150 · S6 0 (carried); `--only s1,s2,s3,s4,s5`; ceiling 1,150p; hold 1,281,805,763 µ¢ ($12.82). NOT approved.

## Plan C run scen-cf86ab8-c1 (owner approval 2026-10-23) — results

Hold 1,281,805,763 µ¢ placed 12:58:22Z; suite 12:58:30Z → 13:43:57Z from the frozen release (founders pinned to cf86ab8); production
on 89d7c21 throughout. Spend: 134 records — 120 usage-billed, 6 provider rejections (PROVIDER_BAD_REQUEST, no charge), 8 refused
unsent; $7.213194 credit = 647.147611p all-in. Imported once (134 rows, totals equal the report); no exception, no unresolved
reservation; hold released. Credit 2,397,499,370 → 1,676,179,930 µ¢, held 0. Ledger verifies (head 1176). Agent-1 (pid 1866135) /
Agent-2 (pid 866408) paused; flags false. Evidence: /var/lib/automaton-fleet-eval/scen-cf86ab8-c1; ~/rlc131/calls.

| Scenario | Suite verdict | All-in | What the evidence shows |
|---|---|---|---|
| S1 correction (360p) | infrastructure | 278.50p | **Achieved.** Delivered 5.6 min (review pass); correction asked 13:04:18, revised PDF delivered 13:08:22 (review pass, resend reason), nothing owed. The grader waited for a chat reply (the agent answered by delivering); the budget then ended it while the agent built an offer of its own; 3 provider rejections → "infrastructure". |
| S2 two kills (250p) | completed | 113.61p | Two real kills (main pid confirmed; systemd's auxiliary-process error recorded), recovery, one delivery, no repeated message — despite 3 provider rejections. |
| S3 B+C (220p) | incomplete | 139.00p | **B not tested (harness):** the order text was cut at PayPal's 127-character description limit ("…with one change:"); the agent asked the buyer instead of guessing — correct. **C precondition failed (harness):** with the renderer removed the workbook inspection still ran and passed; the agent delivered both workbooks with passing reviews. |
| S4 sleep (170p) | incomplete | 87.54p | Inconclusive: a newborn with no work orients and starts its first product (decided, building) — it never settles within the cap. |
| S5 knowledge (150p) | completed | 28.50p | Quoted **£12** (inside £7–£12; b1: £39), England scoped, after reading the enquiry (knowledge shown) and its own economic_knowledge look-up. The grader's "referenced evidence" matched the agent's own price figure — explicit weighing is not shown in its record. |

Repairs, measured: view_image followed by a step in the same turn (the image seen) 7 of 8 (b1: 1 of 11); steps per working
turn 5.1 (b1: 4.0); refusal retries 8 (b1: 113) — every scenario ended at once when no call fitted.

Harness faults found (no model fault in them): the in-process controller discards its audit, so the provider's rejection
reasons (6, all after exec / read_file / deliverable — not images) were not recorded; S1 judges an answer by a chat message
only; S3-B's request exceeds the 127-character order description; S3-C's renderer removal does not block a workbook
inspection; S4 cannot settle a newborn; S5's evidence pattern matches the quoted price itself. Hardening noted, unproven as the
cause of the rejections: tool output is clipped by UTF-16 units and can leave a lone surrogate.

Wake reconstruction (per turn: packet kind, carried unfinished work and why the last turn stopped, first action, tools, own
knowledge look-ups, end) is built from mind-log/carry/memory; the packet text itself is not captured by this build.
