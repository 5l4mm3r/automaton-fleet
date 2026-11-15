# Launch check 2026-10-21 (workbook + email): diagnosis of its 48 calls

Run 3766045b… 10:48:20–11:01:45Z, Agent-1 on runtime a0bbf4e, controller e151095 (v110). Ceiling 300p; spent 225.1186p
in 48 calls (all claude-opus-5-5, T3, founder_work) + 45p AI-credit tax/fee = **270p** (ledger; provisional until reconciled
with Anthropic usage). Ended: the next call reserved 79p with 74.88p left (FLEET_COGNITION_RUN_BUDGET_EXHAUSTED).

Sources (all pre-existing, read-only): fleet_cognition_log (per call: tool names, argument hashes, tokens, stop reason),
fleet_agent_mind_reports, the founder unit's journal, Agent-1's own state files mind-log.jsonl / mind-continuity.json /
mind-progress.json (its credentials file was not read), its workspace file list, fleet_offer_files, fleet_artifact_reviews.

## Incoming email: PROVEN (preserve)
The owner's enquiry, received 11:01:06Z from the owner's address: stored as Agent-1's mail (agent 01M3F50SH7PNX2E3GST13J52AS,
routing `correspondent`, thread 063f6ed3-99a3-4b69-a865-33ef5123449f, no reply headers), not attached to the refunded order,
no closed_order_mail event. Its subject did not use the `Agent-1 - …` form; it reached Agent-1 because the address is an
established correspondent. It arrived during turn 8 (began 11:01:02Z), which ended at the run's ceiling before Agent-1's next
step: **it has not been read or answered**. No outgoing mail was sent.

## What executed (Agent-1's mind log)
Eight turns. Turns 1–7 each ended `FLEET_TURN_CONTEXT_BUDGET` after 5–7 steps (8 tool calls each); turn 8 ended at the run
ceiling. No step produced text; every call ended `tool_use`. Each turn opened the same way, with identical arguments:
`offer` (args b6aea542…, 8×), `field_journal` (cc1cdc5e… 4×, d36e1027… 2×), `deliverable` on the offer (75a3a9cc…, 7×), then
`exec` work and the same `deliverable` inspection (b5e215a3…, 7×; 8 render folders of the unchanged product).
- Changed: only temporary files. Agent-1 extracted the offer's unchanged 24,829-byte workbook (f45c3d00…) into new folders
  five times (rv, chk, vv, pub, q) and converted it to CSV; in turn 6 (10:58:19Z) it saved an office-application recalculation
  (`.tmp/rc/out/in.xlsx`, e9716464…) — that turn ended one second later. Offer files, reviews and publication: unchanged.
- Failed: one call. Turn 3, `deliverable` review → FLEET_REVIEW_AUTOMATED_FAILED, "a spreadsheet saves formulas without
  their values … recalculate and save it with the office application, or pass value= to XlsxWriter's write…" (the log keeps
  260 characters; the full reason is not kept anywhere). Every other call returned ok.

## Platform defect 1 (demonstrated): a correct workbook was reported as unsaved
All 1,194 "formula cell(s) saved without a value" in f45c3d00… are template-row guards such as `=IF(D3="","",EDATE(D3,12))`;
the inspector's own recalculation gives `""` for every one (run locally on the exact file, openpyxl 3.1.5 / formulas 1.3.4 as
pinned). Saved blank = shown blank = correct. The check counted an empty saved value as missing whatever the result, and
openpyxl reads both forms the same (`None`): XlsxWriter's `value=""` (untyped) and the office application's empty text result
(`t="str"`) — verified with the production toolchain on a synthetic workbook. So the remedy the inspector names could not pass
either. Since v109 this warn refuses the review and blocks the sale. The last stored review of this product (10-20 03:29,
fleet-qa-3) had one non-passing spreadsheet check: cached_values=warn.
Fix: a formula whose recalculated result is `""`, saved empty, is saved correctly; one that should show something and is
saved empty still warns. Re-run on f45c3d00…: cached_values pass (dates and rendering need LibreOffice: not run locally).
Inspector name stays fleet-qa-3 (no migration); reviews after the fix are told apart by the runtime commit.

## Platform defect 2 (demonstrated): size-stopped turns lost their working record
The routed turn ends when its conversation exceeds 40,000 bytes (the controller accepts 64 KB). That stop set `finished`, so
the turn was not "cut off": its carry record was cleared (no mind-carry.json exists), its closing note was empty, and the next
turn re-oriented from scratch — the review refusal of turn 3 and the recalculated file of turn 6 never reached a later turn.
Only cut-off turns (all 16 steps) kept a record; Agent-1's log shows no turn has ever reached 16 steps, while size stops ended
3 turns on 10-18/19, 8 on 10-20 and 7 on 10-21. Fix: a size stop is cut off too (record, plan, calls not run, carried).

## The no-progress protection
It behaved as designed and did not stop the run: progress is new information, and each turn's exec outputs were new, so no
turn counted as stalled (mind-progress lastWrites empty; no founder_waiting). Its cut-off rule never applied because size
stops were not cut-off turns (defect 2). With defect 2 fixed, a size-stopped turn that learns nothing new counts as stalled.

## Agent-1 received the specific defect and had working tools
Yes for both, from the evidence: the refusal named saved values and the office-application route; the office application
ran in its sandbox (8 renders, a recalculated file). It followed the inspector's advice; the repetition is what defect 2
produces. Not shown by these logs: whether it would have finished without the defects, and why it wrote no working notes of
its own between turns — its reasoning (thinking is not kept) and the full tool outputs are not recorded.

## Also fixed (bce4b93): the watchdog stopped its own service before recording the stop.
