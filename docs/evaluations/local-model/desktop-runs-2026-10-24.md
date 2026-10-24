# Desktop runs 2–5 (23–24 Oct 2026): one paid order and its correction on Qwen3.5-9B, owner's RTX 5080

**Verdict: no run passed.** Runs 3, 4 and 5 each completed the fixture by its own measure (two sent deliveries, both
reviews `pass` with automated checks OK, nothing owed). By the owner's bar (first and corrected delivery, both reviews
passing, nothing owed, no false "delivered" claim, **the PDF correct**), all three failed on the PDF. Every delivered PDF
was visibly defective, and the inspector and the agent's own review passed each one. I stopped after the three approved
runs (2 runs on this machine before 23 Oct are not counted). The restart-mid-task run and procedure reuse were **not
run**: they were to follow a pass.

**Machine / model:** as in [gpu-2026-10-23.md](gpu-2026-10-23.md) (WSL2 Ubuntu 24.04, RTX 5080 16 GB, Qwen3.5-9B Q6_K,
llama.cpp b11838, `automaton-fleet-inference` on 127.0.0.1:8090). **Scenario:** `s1-order-and-correction`, 45 minutes
(first delivery must land within 22.5), 120 model calls/hour bound, £0.

**Offline evidence (network left on, owner's instruction 24 Oct):** the egress tripwire in the test and founder processes
logged **0 non-loopback attempts** in runs 3, 4 and 5 (each log: only `tripwire armed` lines). The inference unit
reports `IPAddressDeny=::/0 0.0.0.0/0` and was active. The founder's exec sandbox reported `networkDenied: true`. No
cloud credential was in the process (the test deletes ANTHROPIC/OPENAI/COGNITION keys). Cost: `allInMicro` 0 in every run.

## The runs

| | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|
| Code | 51a1f82 | 9409e8a | 26769cb | 75e68c6 |
| Harness verdict | poor_decision (not delivered) | completed | completed | completed |
| First delivery | **none** | 3.9 min | 2.1 min | 2.5 min |
| Correction delivered | — | 9.0 min after the request (harness "resolution" 13.5) | 1.7 min | 7.6 min |
| Reviews of sent deliveries | — | pass, pass | pass, pass | pass, pass |
| Owed at end | 1 | 0 | 0 | 0 |
| Model calls | 120 (bound hit in 3.5 min) | 120 (bound hit) | 76 | 111 |
| FLEET_BAD_REQUEST | 33 | 9 | 16 | 8 |
| Claims to the buyer | **2 false** "has been delivered" | none sent | 1, true (2 s after the delivery) | 1, true (3 s after) |
| Step latency median / p90 | — | 1.7 / 7.2 s | 1.6 / 8.2 s | 1.6 / 16.2 s |
| GPU memory max / power max | — | 10.8 GB / 267 W | 10.8 GB / 264 W | 10.8 GB / 268 W |
| **The PDF** | — | **unusable** (below) | **defective** (below) | **unusable** (below) |

What the buyer received (rendered, and text extracted with poppler; files under each run's `workspace/` or `delivered/`):

- **Run 3, first:** hand-drawn PDF; each line runs off the right edge — 2 of the 10 points visible, a stray "F18 Bold";
  `pdfinfo` reports a syntax error. **Revised:** reportlab, point 7's date line present, the title clipped at
  "…10-POINT CHECKL"; five of ten points read "Check the gas … is in good condition".
- **Run 4, revised:** a table whose rows overflow their cells: point 7's text drawn over the "7", rows 1, 3, 5, 6 into
  the ✓ column; tick boxes are **filled** black squares (■), which read as already ticked. The first delivery's file was
  overwritten in the workspace by the revision and could not be inspected (gap fixed: `delivered/`).
- **Run 5, first and revised:** PDF syntax written by hand (`/Length 2000` past the stream, no `endstream`, wrong
  `startxref`). A viewer shows the title block and **none of the ten points**.

## Run 2: the malformed arguments (task 1)

Run 2's raw arguments for turns 2–6 were not kept (only the last 30 packets and the last turn's carried record survive; the
agent's state directory was deleted with the test's temporary root). From the carried record, refusal reasons, packets and
the source:

| Refusal (count) | What the model sent / what happened | Cause | Class |
|---|---|---|---|
| `deliverable` "paths: 1..20 workspace files" (×11) | later in the run `{"op":"inspect","args":{"paths":["order/checklist.pdf"]}}` worked, so the earlier calls lacked `args.paths` | the local model's compact tool list cut `deliverable` to its first sentence and `{op, args: object}` — no argument named | **interface** |
| `deliverable review` "subject is required", "subject is at most 10 characters", "verdict is required", "subject is offer, order, enquiry or sample" (×4) | `{"op":"review","args":{"paths":["order/checklist.txt"],"brief":"…"}}` and variants | same: subject / criteria / verdict were invisible without `tool_help` | **interface** |
| `wallet deliver` "files: the files to deliver (their names, staged with order.stage_file)" (×12) | deliver without `paths`; the controller's reason named an internal op that no tool has. The model then tried `browser stage_file` and recorded a `legal_signature` "Fleet wallet deliver system block" dependency | compact list hid `deliver {orderId, paths, reviewId}`; the refusal leaked an internal name | **interface** |
| `wallet` "op is one of …" (×3), `customers` op (×1), `opportunity` "key is required" (×1) | an op or field that does not exist (unrecorded) | | model |
| `exec` "command required" (×1) | a 3.3 KB reportlab heredoc — the command WAS there | `str(command, 2000)` returned null over 2000 characters, reported as missing | **interface** |
| `web_search` / `web_fetch` (turn 1, ×34; 2 more later) | research before the order although the packet led with it | | model |
| false "has been delivered" messages (×2) | sent before any delivery | | model (now refused by the platform) |

## What changed (local commits on `fleet/final-v2.5`, not pushed)

| Commit | Change | Tests |
|---|---|---|
| 9409e8a | **Compact tool list:** `deliverable`, `wallet`, `customers` keep the arguments of the ops a paid order needs. **Unambiguous repairs only:** fields given beside `op` are the op's fields (`args` wins); one `path` / deliver `files` given as workspace-path strings mean those files (ops taking `paths` only); an order review with only `orderId` has subject `order`. **Refusals:** deliver without paths says what it needs (no `order.stage_file`, "not an external block"); exec over 2000 characters says so. **False claim guard:** `order_message` stating a delivery while FleetController's record says the delivery or revision is owed, and no `wallet deliver` succeeded this turn, is refused `FLEET_CLAIM_UNSUPPORTED`. **Evidence:** the mind log keeps the clipped arguments of refused calls. | `fleet-local-run2-tool-args.test.ts` (10) |
| 26769cb | **Inspector `text_off_page`:** visible characters outside the page's crop box fail, naming the page, count and where the lost text starts. **Procedures:** an exec that exited non-zero, look-only commands (`pwd`, `ls`, …) and exact repeats are not build steps; absolute host/sandbox workspace paths become relative; each kept script listed once. | `fleet-qa-text-off-page.test.ts`, `fleet-founder-procedures.test.ts` (+1) |
| 75e68c6 | **Inspector `text_overlap`:** ≥ 4 characters from different places in the text whose boxes cover each other over nearly their whole height fail (neighbours, glyphs drawn twice for bold, superscripts grazing the line above pass). **Evidence:** `delivered/` holds every delivered file as sent (bytes checked against the record). | `fleet-qa-text-off-page.test.ts` (+1) |
| c7df423 | **Inspector `pdf_content`:** a page whose text extraction raises (a damaged content stream) fails, with the way round; it is no longer reported as "no text layer". **Not verified by a live run.** | `fleet-qa-text-off-page.test.ts` (+1) |

The inspector stays `fleet-qa-3` (as for its Oct 20–21 changes); every review records the script's sha256, so reviews made
before and after are distinguishable. A version bump would need a migration and changes which reviews sales accept — a
policy decision left to the owner.

Verified on the real files: every defective PDF delivered in runs 3–5 now fails on its defect; a correct reportlab page,
a reportlab table with wrapped cells, justified 9/9 pt text, bullets, superscripts, glyphs drawn three times and
underscores pass.

Tests run (targeted): 13 files, 108 tests pass — the four above plus `fleet-qa-inspector{,-v2,-v3}`, `fleet-v76/v85-founder-tools`,
`fleet-money-checks`, `fleet-founder-work-continuity`, `fleet-cognition-local`, `fleet-v100-customer-obligations`,
`fleet-v111-obligations-priority`. `npx tsc --noEmit` clean. One **pre-existing** unhandled rejection: continuity test 1j's
mock provider returns no `toolCalls` (`mind.ts` "reading 'map'"); identical at 51a1f82 before any change; its 27 tests pass.
Not fixed here.

## Fixable or model limit? (task 2)

**Fixed platform defects (interface or verification):** every run-2 delivery-path malformation listed as *interface*
above. From run 3 on the delivery path was well-formed apart from single slips, each refused with a clear reason and
recovered within one or two steps (runs 4–5: `subject` given as the file name, an 8-character `orderId`, criteria under 5
characters, a missing `verdict`, an `.html` delivery, a wrong `after`). The run 2 false-claim pattern did not recur. The
three PDF defects that passed inspection were platform gaps — the inspector could not see what the buyer sees — and are
fixed (the last one unverified live).

**Model limits (9B), shown in every run, not fixable in the tool interface:**

- **It cannot reliably produce a correct PDF.** Two of four builds wrote PDF syntax by hand (runs 3 and 5), one laid
  text past the page, one overflowed a table. With the new checks these now fail inspection with a specific reason
  and the way round. Whether the 9B then fixes them within the call budget is **unmeasured**. That is the next run's
  question.
- **Its own review is not a review.** Every one of these PDFs got a `pass` from the agent, criteria "met", including
  run 5's, where no point is visible. The platform's automated part is now stricter; the judgment part is the model's.
- **Content quality:** generic or repetitive points ("… is in good condition" ×5), filled squares as tick boxes.
  This is judgment, and no rule here can decide it; an `independent_review` call or a larger model would.
- **Detours:** turn 1 goes to web research or opportunity work in every run, though the packet leads with the owed
  order. Runs 2–3 hit the 120 calls/hour bound partly because of this.

## Open issues and risks

- `pdf_content` fails any PDF whose pypdf extraction raises. A valid but unusual PDF (exotic encoding) could be failed
  wrongly. Agent-built PDFs (reportlab, LibreOffice) did not trigger it here.
- `text_overlap` thresholds (40% area, 80% height, ≥ 4 characters) are set from these files and synthetic cases only.
- The false-claim guard matches statements ("has been delivered", "I've sent", "please see the revised"); a claim
  phrased otherwise passes. It was not exercised in runs 3–5 (no false claim was attempted).
- Procedures: run 5's kept `which pdftk … 2>/dev/null || echo …` as a build step (the look-only filter treats any `>` as
  a write). Two scripts of the same name in different folders still share one copy under `procedures/scripts/`.
- Refusal reason gap seen in run 3 (off the delivery path): "close one of your 3 open browser sessions first" gives no
  session ids and there is no op to list them.
- The fixture's verdict `completed` does not look at the document. A "PDF correct" judgment is manual (this report).

## Next (needs the owner)

1. Approve further offline runs of the same fixture on c7df423: does the 9B fix an inspector failure into a correct PDF
   within the bound? Pass = the owner's bar above. Then the restart mid-task and procedure reuse on a different order.
2. Decide whether the inspector changes warrant `fleet-qa-4` (a migration; which reviews sales accept).
3. Push of the four local commits: not done; awaiting approval.

## Evidence

| Run | Directory (this desktop) |
|---|---|
| 2 | `~/local-demo/s1-order-and-correction-run2/` (its report.json, terms.json) |
| 3 | `~/local-demo/s1-order-and-correction-run3/` (+ `run3.log`, `gpu-run3.csv`, `egress.log`) |
| 4 | `~/local-demo/s1-order-and-correction-run4/` (+ `run4.log`, `gpu-run4.csv`, `egress.log`) |
| 5 | `~/local-demo/s1-order-and-correction-run5/` (+ `delivered/` both files as sent, `run5.log`, `gpu-run5.csv`, `egress.log`) |

Each holds `result.json`, `report.json`, `calls.jsonl` (per model call: tokens, latency, zero price), `mind-log.jsonl`
(runs 3–5: refused calls with their arguments), `deliveries.json`, `customer-messages.json`, `buyer-mail.json`,
`obligations.json`, `workspace/` (incl. `procedures/deliver-pdf.md`). Metrics: `python3 -I scripts/fleet-local-metrics.py <dir>`.

## Before run 6 (24 Oct, after the review of run 5)

**Run 6 (8da6a94, owner-approved, one run): FAILED — the correction was never applied; the "revised" delivery is
byte-identical to the first.** See "Run 6" at the end.

**Status of this document:** not committed; it stays in the working tree by the owner's leave ("uncommitted is fine").
The code is in local commits; nothing is pushed. Desktop at the time of writing: `fleet/final-v2.5` at **b9d9bd1**
(`c7df423` → `90b5782` → `b98a9ff` → `f9db421` → `8da6a94` → `f893ddf` → `b9d9bd1`); working tree: only this file untracked.
`origin/fleet/final-v2.5` is still `51a1f82`. Current state: "Candidate for run 7" and its addendum (b9d9bd1) at the end. Earlier sections are
history (the guard section and "Candidate for run 6" were superseded by later commits).

### Desktop runs 1–5 from their saved evidence

| | Run 1 | Run 2 | Run 3 | Run 4 | Run 5 |
|---|---|---|---|---|---|
| Code | db40995 | 51a1f82 | 9409e8a | 26769cb | 75e68c6 |
| Started → ended (UTC) | 22:04:54 → 22:50:05 (23 Oct) | 23:13:22 → 23:36:03 | 00:17:31 → 00:35:04 | 00:39:38 → 00:43:38 | 00:47:12 → 00:57:30 |
| Elapsed / local calls | 45.2 min / 84 | 22.7 min / 120 | 17.5 min / 120 | 4.0 min / 76 | 10.3 min / 111 |
| Initial delivery | yes, 1.8 min | **no** | yes, 3.9 min (00:21:31) | yes, 2.1 min (00:41:52) | yes, 2.5 min (00:49:48) |
| Correction delivered | **no** (time limit) | — | yes, 9.0 min after the request (00:30:34) | yes, 1.7 min (00:43:34) | yes, 7.6 min (00:57:23) |
| PDF readable, requirements met | unknown: the file was not kept | — | **no**: first, lines past the page edge, 2 of 10 points visible; revised, title clipped | **no**: revised, text over text, ■ as tick boxes; first overwritten, not kept | **no**: both damaged hand-written PDF, title only, no points visible |
| False "delivered" claim | yes, "please see the revised PDF" before any revision | yes ×2, before any delivery | none sent | none (true, 2 s after) | none (true, 3 s after) |
| First decisive failure | the revised file's review returned as "already done" (stale), redelivery refused `FLEET_REVIEW_STALE`; then the revision was not owed work and the agent slept | the delivery arguments were never well-formed: the compact tool list named none of them (33 refusals) | the first PDF: PDF syntax written by hand with text off the page, passed by the agent's review and the inspector | the revised PDF: a table overflowing its cells, passed by both | both PDFs: damaged hand-written PDF, passed as "no text layer" |
| Platform or model | **platform** | **platform** (interface); the 2 false claims and the 34 research calls in turn 1 were the model | model's PDF, **platform** gap: the inspector could not see it | model's PDF, **platform** gap; filled tick boxes are judgment (model) | model's PDF, **platform** gap |
| Fixed by | 51a1f82 (done records keep file state; v112 revisionOwed; procedures read nested args; workspace kept in evidence) | 9409e8a (arguments named; unambiguous repairs; refusal reasons; claim guard) | 26769cb (`text_off_page`) | 75e68c6 (`text_overlap`; `delivered/` keeps every delivered file) | c7df423 (`pdf_content`) — not yet verified live |

Also in the evidence, **platform**: when the 120 calls/hour bound was reached the founder retried about once a second
until the run ended. Run 2: bound reached 23:16:57 (3.5 min in), then 1,095 refused attempts (267 `FLEET_COGNITION_RATE_LIMITED`,
828 `FLEET_RATE_LIMITED`), median gap 1.04 s, for 19 min. Run 3: bound reached 00:30:35, 1 s after the revised delivery,
then 255 refusals, median gap 1.05 s, until the end. (`mind.ts` rests only after `FLEET_COGNITION_PROVIDER_RATE_LIMITED`;
the heartbeat loop calls the next turn at every slot.) The fix is said to be **8077f6c, which is not on this desktop**:
not in this repository after `git fetch origin` (the remote has no such object), not in the Windows-side checkout
(`C:\Users\o\Documents\GitHub\automaton-fleet`, last commit 2026-09-30), and no SSH host is configured. Not reimplemented here.

Evidence: run 1 — numbers only in [gpu-2026-10-23.md](gpu-2026-10-23.md); its evidence directory is not on this desktop
(the run predates evidence of the workspace). Runs 2–5 — `~/local-demo/s1-order-and-correction-run{2,3,4,5}/`
(`result.json`, `deliveries.json`, `customer-messages.json`, `mind-log.jsonl`, `workspace/`, run 5 `delivered/`); run 2's
console log `~/local-demo-run.log` and egress log `~/local-demo-egress.log`; runs 3–5 `~/local-demo/logs/run{3,4,5}.log`.
GPU samples: `~/local-demo-gpu.csv` (from run 2) and `~/local-demo/logs/gpu-run{3,4,5}.csv`. **These samplers were left
running after their runs** (`kill` reached the wrapper, not the sampling loop) and appended idle rows until stopped at
12:09 on 24 Oct; only rows inside each run's start–end window above belong to it. The files were not edited.

### The "delivered" guard (90b5782, b98a9ff) — superseded by 8da6a94

- **90b5782:** while only a revision is owed, a sentence about the earlier delivery ("the original was sent earlier; the
  revision is in progress") is sent as written; a sentence that claims a delivery and names the revision, or does not say
  which delivery, is still refused. While the first delivery is owed, nothing changed.
- **b98a9ff:** (1) the claim pattern recognises a verb pair — "Point 7 has been updated and sent.", "I've corrected and sent
  the checklist." — the regression case is restored as written. (2) The licence a delivery gives is tied to
  FleetController's record: a wallet deliver counts only when the controller answers `ok: true` with the order's
  `delivery.deliveryId`, and it is the **revision** only when the order was already delivered before it (FleetController's
  obligation record at the start of the turn, or an earlier delivery of this turn). After a first delivery, a claim that
  names the revision (revised / updated / corrected / amended / fixed / change / point N) is refused until the revision
  is delivered; "your new checklist has been delivered" is true and sent.
- Not covered: a claim phrased outside the pattern; a correction that arrives mid-turn on an order delivered in an
  earlier turn (the obligations are read at the start of the turn).

Tests: `fleet-local-run2-tool-args` 12/12, with procedures and the inspector 21/21; `npx tsc --noEmit` clean. All 32 files
that use the toolbox: 8 failures in 4 files (`fleet-cognition-anthropic` 4, `fleet-research` 1,
`fleet-storefront-gateway-pg` 2, and one of `fleet-r24-experiments` / `fleet-v76-e2e-demonstrations-pg`, which alternate
between runs). The same count fails with the change stashed; the v76 failure (a JSON parse error) also fails on c7df423.

## Candidate for run 6: 8da6a94 (prepared; run 6 not started)

### 1. Hourly call bound — f9db421, an equivalent implementation, not 8077f6c

8077f6c could not be obtained: this desktop has no SSH keys or configuration (no route to the VM), origin has no such
object, and the Windows-side checkout predates it. f9db421 implements the behaviour instead: when FleetController's
status shows `turnsLastHour >= maxTurnsPerHour`, or a call is refused `FLEET_COGNITION_RATE_LIMITED`, the founder makes
no call until the oldest of its own calls that keeps the count at the bound leaves the rolling hour (+2 s); with
nothing known (an older controller, a restart) it backs off 60 s, doubling. Each rest is 30 s–10 min; the heartbeat
loop keeps running, so shutdown and the evaluation deadline are unaffected. The cap (120 in the fixture) is unchanged.
Test `fleet-founder-hourly-bound` (3): 590 one-second heartbeats after a refusal make no call (was ~1 per heartbeat);
with the count in the status no refused call is made at all; calls resume when the oldest call leaves the hour.

### 2. Document renderer — `deliverable render`

Existing tools inspected first: the agent toolchain has reportlab, pypdf, pypdfium2; the toolbox already renders
invoices with reportlab inside the sandbox; there was no layout helper, so the 9B wrote canvas code or PDF syntax by
hand. The new op takes `{source: workspace .json, out: .pdf, content?, require?}`; the content (title, subtitle,
pageSize, blocks: heading | text | bullets | checklist [text | {text, lines}] | lines | table, footer) is saved to
`source`, so it stays editable — edit it and render again. reportlab platypus lays it out (18 mm margins, wrapping,
spacing; table cells wrap), tick boxes are drawn outlines and write-in lines are ruled; text the standard fonts cannot
draw (a typed ☐ ☑ ■) is refused with the reason. The result is inspected at once. Procedures record the render as a
build step and keep the content file as a template. Nothing of the fixture's order or correction is prewritten.

### 3. Inspection against the saved bad files

The current inspector (sha256 `84749a94…`) on the bytes delivered in runs 3–5 (copies; the evidence is untouched) and
on two independently valid documents, with the phrases the order and its correction require:

| File (delivered bytes) | malformed (`pdf_content`) | clipping (`text_off_page`) | overlap (`text_overlap`) | missing (`required_content`) |
|---|---|---|---|---|
| run 3 first | pass | **fail** p1: 346 chars past the edge | pass | pass |
| run 3 revised | pass | **fail** p1: 13 chars (title) | pass | pass |
| run 4 revised | pass | pass | **fail** p1: 6 chars over other text | pass |
| run 5 first | **fail** p1: no `endstream` | pass | pass | pass |
| run 5 revised | **fail** | pass | pass | **fail** "next annual check" not visible |
| valid: renderer output (a tenant's moving-out list) | pass | pass | pass | pass |
| valid: independent reportlab document | pass | pass | pass | pass |

Each check answers one question; none implies the others (run 3's first file has all its required phrases on the
page yet loses 346 characters past the edge). Run 4's first delivery is not in the evidence (overwritten before
`delivered/` existed). **Not detected by any check:** run 4's filled ■ tick boxes and generic content — judgment; the
renderer draws empty boxes instead. Findings returned to the agent name the page, the count, the start of the lost or
overlapping text, or the missing phrase, and the way round.

### 4. Delivery truth

A message claiming a delivery is now checked against FleetController's record read at that moment (`order.thread`),
not the turn-start snapshot. The buyer can reach a delivery only once it is `sent` (the mail provider accepted it; the
order page lists only sent files), so a `queued` or `failed` delivery licenses no claim — the refusal says to say it
is queued. A buyer message after the latest sent delivery (a correction, including one that arrives mid-turn) is not
delivered by it: only a sentence about the earlier delivery may say it was sent. An unreadable record refuses the
claim. Known limits: claims phrased outside the pattern pass; an earlier delivery is known from the turn-start
obligations or a sent state read earlier in the runtime.

### 5. Targeted checks on 8da6a94

`npx tsc --noEmit` clean. 19 files, 179 tests pass: the new `fleet-document-render` (4) and
`fleet-founder-hourly-bound` (3), `fleet-local-run2-tool-args` (12), `fleet-qa-text-off-page` (4),
`fleet-founder-procedures` (6), `fleet-qa-inspector*`, `fleet-v76/v85-founder-tools`, `fleet-money-checks`,
`fleet-founder-work-continuity`, `fleet-cognition-local`, `fleet-v100-customer-obligations`,
`fleet-v111-obligations-priority`, `fleet-founder-step-budget`, `fleet-r23-cognition`, `fleet-r41-1-continuation`,
`fleet-founder-conversation`. The pre-existing continuity 1j unhandled rejection remains (unchanged).

Also: the GPU samplers of runs 2–5 were stopped (see the evidence note above); no evidence file was edited or removed.

### Proposed run 6 (one bounded local run; a separate decision)

- Code 8da6a94, built (`npx tsc`, the runtime runs from `dist/`); `s1-order-and-correction`, 45 min, 120 calls/hour,
  local inference only (`automaton-fleet-inference`, `IPAddressDeny` any), egress tripwire on, no cloud credential
  in the process; a fresh evidence directory `~/local-demo/run6-<UTC timestamp>/` (nothing earlier touched); GPU
  sampled with `nvidia-smi -l 5 &` and that pid killed at the end (`pgrep -af nvidia-smi` empty).
- The scenario ends when the corrected delivery is sent (or at 45 min); remaining calls are not spent.
- Pass, all of: the first PDF correct and readable and its delivery `sent`; the buyer's correction applied without
  breaking the document and the corrected delivery `sent`; both reviews passing; nothing owed; no false "delivered"
  claim reaching the buyer; 0 non-loopback attempts; `procedures/deliver-pdf.md` written and reusable (a build step,
  not order-specific values). Judged by rendering and reading **both delivered files' bytes** from `delivered/`,
  and running the inspector on them — not by the harness verdict.

## Run 6 (24 Oct 2026, 11:32:49–11:40:42 UTC; candidate 8da6a94) — failed

Owner-approved single run; 45 min / 120 calls an hour; local inference only; egress tripwire on. Evidence:
`~/local-demo/run6-20261024T113249Z/` (`evidence/s1-order-and-correction/` incl. `delivered/` — both delivered files as sent,
sha-checked against the record; `snapshots/first-114022/` — the first PDF and its content file copied mid-run, identical
to delivered file 1; `run.log`, `egress.log`, `gpu.csv`, `commit.txt`). Harness verdict `completed` — **wrong by the
owner's bar**, because it does not compare the two deliveries' bytes.

| | Initial fulfilment | Correction |
|---|---|---|
| Elapsed | delivered (status `sent`) 11:39:56, 6.9 min after the order (turn 1 went to research and four ~88 s browser calls) | "delivered" 11:40:40, 0.7 min after the request (11:39:57) |
| Calls | 44 local model calls in all (cap 120 not reached; no hourly-limit refusal) | (same run) |
| Delivery status | `sent`, review `pass` (automated ok) | `sent`, review `pass` (automated ok) — **same file, sha256 `2e91c888…` both times** |
| Document | one A4 page, legible, all ten points, a drawn empty box per point, nothing off the page or overlapping. Defects: every item numbered twice ("1. 1."); the title repeated as a heading; write-in labels carry typed `[ ]` pseudo-boxes and underscores before the ruled line; an "Important Notes" heading with nothing under it; the intro paragraph missing (a block with both `heading` and `text` kept only the heading) | **the correction is not in the PDF.** The content file has it (point 7: "Next annual check date: ____"); the PDF was never re-rendered |
| Claims to the buyer | none sent by the agent (its last message was refused: the scenario had ended); the delivery emails are the standard template | the resend reason ("Added 'Next annual check date' line to Point 7") and the review's criteria say the line was added — false, but not shown to the buyer |
| External connections | 0 non-loopback attempts (tripwire); £0 | |
| GPU | max 11.0 GB, 250 W | |
| Procedure | `procedures/deliver-pdf.md` written: render → review → deliver, content file kept as a template; reusable in shape, but counts the false revision as a second success ("worked 2 times") and records no `require` | |

**First decisive failure — platform (my omission in 8da6a94):** after the agent edited `order/checklist.json` for the
correction (11:40:21), its `deliverable render` was refused `FLEET_ALREADY_DONE` (11:40:23) with the previous render's
result. The continuation guard repeats nothing "exactly the same" unless the files the call names changed; it reads
those files from `path` / `paths` / exec words only (`callDeps`, `loop-guard.ts`), not render's `source` / `out`, so the
edited content looked unchanged. The agent then reviewed the old PDF (its criteria claimed the date line — a model
rubber stamp; it passed no `require`, so the automated check could not see the gap) and re-sent it.

Contributing: platform — a revision byte-identical to the latest sent delivery was accepted by the toolbox and
controller, and counted by the harness; the renderer numbers items the model already numbered and silently drops all
but one kind in a multi-kind block. Model — malformed review criteria and a wrong `after` (each refused and recovered in
one step), false criteria and resend reason, the research detour in turn 1, `require` never used.

**Fixes before any further run (proposed, not made):** (1) `callDeps` includes render's `source` and `out` (a render
after an edit runs). (2) `wallet deliver` refuses a resend whose files are byte-identical to the latest sent delivery,
naming why. (3) Renderer: a block with more than one kind is refused with the reason; an item that already starts with
its number is not numbered again. (4) Harness: `completed` requires the second delivery's bytes to differ from the
first. (5) Each with a test reproducing run 6's sequence (edit → render → review → resend).

## Candidate for run 7: f893ddf (prepared; run 7 not started)

The run 6 chain, link by link, and what now happens instead (replayed without a model in `fleet-run6-replay`, using run 6's
own delivered PDF and edited content file, copied byte for byte into `src/__tests__/fleet/fixtures/run6/`):

| Run 6 | Now |
|---|---|
| content edited → render refused `FLEET_ALREADY_DONE` | a render depends on its **source** (`callDeps`): the edit makes it a new call; the unchanged call is still not repeated; touching only the output is not a new input. Tested on the guard's own predicate (the guard runs inside a model turn; the predicate is what decided run 6) |
| (renderer) heading + text in one block → text dropped; "1. 1."; an unknown `description` field ignored | every part of a block renders in the order written; unknown fields/parts refused with the reason (run 6's exact edit is refused for `description`, then renders once it is removed); an item already numbered is not renumbered; typed underscores after a label dropped |
| old PDF reviewed, criteria "met: true" | while the buyer has written since the latest **sent** delivery (FleetController read at that moment), a review needs `require` (the visible text of the change) — `FLEET_REVIEW_REQUIRE_CHANGE` otherwise. The inspector checks it on the page; the old PDF reviewed with the change stated fails the automated part, so no passing review exists for it |
| unchanged file re-sent as the revision | `FLEET_REVISION_UNCHANGED` (same bytes as the latest sent delivery) and `FLEET_REVISION_UNREVIEWED` (no review that stated the change). Legitimate resends stay possible: a failed or queued delivery is recovered as before; the same file on request with `unchanged: true` |
| harness `completed` | S1 is `completed` only when the **delivered bytes** pass the grade (`s1-correction-check.ts`): both versions keep the order (points 1–10 visible, ≥ 10 usable empty boxes — drawn, glyph or typed `[ ]`, never filled — the subject visible, inspector clean), the revision is not the first file, and under point 7 (before point 8) a line names the date of the next annual check with somewhere to write it (a drawn rule or underscores) |
| procedure "worked 2 times" | "dispatched N times" with "dispatched means reviewed and sent, not that the buyer's request was met"; a same-file resend is not recorded. Run 6's own record is marked in `~/local-demo/run6-20261024T113249Z/VERDICT.md` (evidence otherwise untouched) |

The grade on saved deliveries: run 6 as delivered — **fail** (identical bytes; no date line under point 7); run 6's
first file + its own edited content rendered by the fixed renderer — **pass** (label "Next annual check date:", drawn
line); runs 3, 4, 5 — **fail** on their defects (off-page, filled boxes / overlap, damaged).

**Limits that remain:** the grade checks presence, position and legibility — not factual accuracy or usefulness of the ten
points (the owner's manual reading stays part of the bar). The S1 grade is specific to this fixture's correction. A
model can still pass `unchanged: true` to resend the same file; the grade then fails the run. The claim guard and the
revision checks read FleetController per call; an earlier delivery known only from a previous runtime counts as unknown.

**Turn 1's research (checked before any prompt change):** turn 1's packet was built at 11:32:59.6Z with no order in it
(objective: "no open goal — assess what is worth doing"); the order was created about 11:33:02Z (first delivery 6.9 min
after it, at 11:39:56Z). So the agent did not ignore a paid order: the fixture created it ~2–3 s after the first packet.
The turn then ran 15 steps over 6.5 minutes (four ~88 s browser calls) without seeing it, because a packet is built only
at a turn's start. Not changed here; options for the owner: create the order before the founder's first turn (fixture),
or a mid-turn notice of a newly paid order (platform).

**Checks on f893ddf:** `npx tsc --noEmit` clean; 20 files, 184 tests pass (new: `fleet-run6-replay` 3; added to
`fleet-document-render` 1 and `fleet-founder-procedures` 1); the pre-existing continuity 1j unhandled rejection remains.
Test changes are to assertions whose wording changed by design ("dispatched", the renderer's error text) and one claims
test that now delivers its resend explicitly as `unchanged: true` (its subject is queued vs sent; revision acceptance is
covered by the replay).

**Housekeeping:** run 6's watch on the agent's log (monitor `bbgb1dt7n`, following a log file the finished run had
deleted) was the one monitor still running; it was stopped. No other monitor or sampler belongs to these runs.

### Addendum: b9d9bd1 — two production gaps closed before run 7

1. **An unchanged resend no longer resolves a correction (schema v113, a new migration; dev registries only — production
   is on v75).** FleetController now decides, not the agent: a buyer's request is answered only by an *effective* sent
   delivery — the order's first, or changed files on a review whose automated report passed `required_content` — or, as
   before, by the agent's resolving answer. A resend of the same files (recovery, or `unchanged: true`) still reaches the
   buyer but answers nothing; `revisionOwed`, the obligation's resolution and `order.thread` use the same rule, and the
   runtime's checks read it. Regression: `fleet-v100-obligations-pg` (same file → still owed; changed but unverified →
   still owed; changed and verified → answered; a resolving answer still closes) and `fleet-run6-replay` (after an
   explicit unchanged resend: a delivery claim is refused, a review without the change is refused, the same bytes again
   are refused; only the rendered change, shown on the page and delivered, answers it).
2. **New paid work reaches a running turn.** Between steps of a routed turn — every tool of the step finished and
   recorded — the mind re-reads the controller's attention (at most every 10 s, a free read); a delivery or revision owed
   that the turn did not start with ends the turn (`FLEET_NEW_PRIORITY`). The record is carried like a cut-off turn's, so
   completed actions are answered from it and never repeated; the next packet leads with the order. Owner conversations
   are not interrupted. Regression (`fleet-founder-new-work-midturn`, scripted model, 6 s per step): an order paid while
   turn 1's first tool call runs ends turn 1 after 2 of 12 steps; turn 2's packet leads with "DELIVER the paid order
   27de487c"; the external call completed in turn 1 reached the controller once (its repeat answered `FLEET_ALREADY_DONE`);
   with no new work the turn runs all 12 steps. The fixture's order timing is unchanged.

**Limits (stated as they are):** model-selected `require` text proves the stated phrases are visible on the page — not
that they are the buyer's actual requirement, nor understanding or factual accuracy; the run 7 grade checks this
fixture's correction (a date line under point 7) and the original's shape, and the owner's reading stays part of the
bar. The agent's resolving answer (`resolved: true`) still closes a buyer's message by its own judgement (meant for
"thanks"-type messages); so after a resend on request the message stays open until the agent answers it that way. A
single long tool call (e.g. an 88 s browser call) is not interrupted — the check runs when it finishes. The mid-turn
check is in the routed turn (all local runs); the older non-routed loop does not have it.

**Checks on b9d9bd1:** `npx tsc --noEmit` clean; 23 files, 204 tests pass (incl. the PostgreSQL obligations, replay,
mid-turn and migration/privilege tests); the pre-existing continuity 1j unhandled rejection remains.

Run 7 needs the owner's approval; it is not started.
