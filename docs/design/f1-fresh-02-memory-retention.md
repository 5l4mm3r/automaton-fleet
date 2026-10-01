# F1-FRESH-02 — founder memory retention and fact capture (2026-10-01)

Status: **implemented and tested locally.** Not deployed; Founder 1 untouched; no model calls. This follows
F1-FRESH-EVAL-02, which is sealed as **INCONCLUSIVE** because its retention guard failed. Both freshness evaluations
stay sealed as recorded (F1-FRESH-EVAL-01 NOT_PROVEN, F1-FRESH-EVAL-02 INCONCLUSIVE).

## Investigation (sealed evidence, read-only)

`src/fleet/eval/f1-fresh-eval-02-retention.ts` replays each memory cell's executed memory writes, in order, through the
store that cell used:
- FRESH: the production fact store;
- LEGACY: the evaluation's string store.

For every cell the replay reproduces the sealed `facts.json` exactly. After each trunk turn it measures which of the 8
operational facts are present in current memory, using phrasing-tolerant investigation detectors. These are separate
from the pre-registered ones, and the sealed scores are unchanged.

| | Turn 1 (8 facts in the news) | Turn 2 (1 operational fact) | Turn 3 (4 operational facts) |
|---|---|---|---|
| Facts written | 1 summary per cell | 1 summary superseding turn 1 | 1 summary superseding turn 2 |
| News captured | **48/48** | **6/6** | **24/24** |
| Unmentioned facts carried through the rewrite | — | **19/42 (45%)** | 18/19 |

### Findings

1. **Fact selection.**
   - The model always called `remember_fact`, once per turn, with one consolidated summary: no fact was "chosen not to
     be stored".
   - It never stored operational facts separately.
   - Turn 1's summary contained all 8 facts in every cell.
2. **Root cause: lossy summary supersession.**
   - Turn 2's news was a single fee correction (plus a rumour). Each founder wrote a new summary *of that turn* and
     superseded the previous summary.
   - The rewrite kept on average 3 of the 7 facts it did not mention. Stock, lead time, refund window and quota were
     dropped most.
   - Facts that changed again in turn 3 came back with the news. The **never-changing** quota was never restated, so it
     stayed lost: in 5 of 6 cells, including all three LEGACY cells.
   - Nothing told the founder that its rewrite had dropped anything.
   - This is a structural risk for exactly the facts that matter most and change least.
3. **Tool-call limits: did not contribute.** At most 2 calls ran in one step, there were 0 `FLEET_TOOL_CALL_LIMIT`
   refusals, and turns had steps to spare.
4. **System prompt: a contributing factor.**
   - "Keep compact conclusions", "Be economical" and `remember_fact`'s invitation to retire an "outdated status" through
     `supersedes` all favour one rewritten status fact.
   - Nothing said that replacing a fact retires everything it said.
5. **Representation.**
   - One summary fact contained every domain.
   - Keys were dated or generic (`O7_status_2026-09-24`, `O7_unit_economics`), so no key identified a domain.
   - Where values were stored they were phrased compactly ("30d", "20/mo", "5 biz day").
6. **Retrieval: did not contribute.**
   - Every probe packet carried the complete current summary: the largest value was 994 characters, under the 1,000
     the packet shows, and packets were 2.9–5.4 KB of the 8 KB knowledge budget.
   - FRESH kept the dropped values in superseded history, but `recall_facts` was never asked for history, and the
     packet is current-only by design.
   - Latent risk, not seen in this run: a summary longer than 1,000 characters is clipped in packets (the full value
     stays available through `recall_facts`).
7. **Detector quality: some misses, identified for future instruments only.**
   - **q5:** stored in C-FRESH-2 and C-FRESH-3 as "Refund window now 30d"; the pre-registered `\b30[- ]?days?\b` misses
     "30d".
   - **q7:** C-FRESH-2 **did** store "Listing quota 20/mo"; `\b20 listings\b` misses it, and its answer of 20 came from
     memory.
   - **q6 in C-FRESH-1:** genuinely absent as a stated value. The turn-3 summary gave only "contribution print £8.92 at
     £12 / ~£10.285 at £13.50", and the founder derived £2.00 from it correctly.
   - So the quota was genuinely absent from current memory in 5 of 6 cells, not in all 6.

## Fix (smallest robust change)

| Change | Where | Effect |
|---|---|---|
| `remember_facts` | `facts.ts` `rememberFacts`, toolbox, tool definition, capability `memory.private` | Up to 20 independent facts in one atomic call (all or nothing, one save) with exactly `remember_fact`'s rules. Operational facts stay individually addressable without one tool call per fact (the mind runs at most 5 per step). Each key may appear once per batch, and a batch cannot supersede a key it also writes. |
| Carry-forward report | `facts.ts` `statedValues` / `notCarriedForward`, used by `rememberFact` and `rememberFacts` | When a write retires a value (same-key update or `supersedes`), it lists the values the retired text stated (numbers, amounts, percentages, dates, each with its clause) that **no current fact states any more**: `NOT CARRIED FORWARD … If any still hold, keep them as their own facts`. It is advisory: a correction legitimately drops the old value. It is deterministic and bounded (8 clauses of 90 characters), and the result also carries `notCarried`. |
| Guidance | `remember_fact` description, `remember_facts` description | "Replacing a fact retires everything it said: keep independent operational facts (prices, fees, limits, lead times, stock, policies) under their own keys rather than only inside a summary." |

**Counterfactual on the real outputs (tested).** Replaying the sealed turn-2 rewrites through the new store reports
the dropped quota in exactly the 5 cells that lost it, and not in C-FRESH-2, which kept it. Every report also names
the dropped lead time.

**Unchanged:**
- the summary ability;
- `facts.json` shape;
- the ledger format (`fleet-facts-v1`);
- packet rules;
- the step and tool-call limits;
- token budgets.

**Not adopted:**
- **Raising the limits:** the evidence shows they were not the cause.
- **A model-side post-turn completeness check:** it needs another inference.
- **Refusing lossy supersessions:** that would block legitimate corrections.
- **Deterministic domain keys:** that needs a domain ontology the founder does not have.

## Compatibility and deployment shape

- **No schema migration and no manifest change.** The tool's class is `memory.private`, so the founder-v2 digest stays
  `30a70609…`.
- **New controller, old founder runtime:** `remember_facts` is advertised but unimplemented, so it is refused
  (`FLEET_TOOL_NOT_AVAILABLE`, nothing written) and the founder can fall back to `remember_fact`. That is today's behaviour, with the new guidance.
- **Old controller, new runtime:** the tool is not offered. `remember_fact` still gains the carry-forward report, because
  that is runtime-side.
- **Legacy `facts.json` (no ledger)** loads unchanged. A batch migrates lazily exactly like a single write (tested).
- **Overhead:**
  - the tool definitions add about 1.05 KB of prefix, roughly 350–400 input tokens per founder call (about $0.0008
    uncached at T2, less when the prefix is cached);
  - a carry-forward report adds about 100–150 output characters of tool result, only on a write that drops values;
  - no extra calls.
- **Pinned tool-count test:** the routing verifier's count went from 19 to 20 (updated deliberately).

## What this does not prove

The store now makes lossy rewrites visible and atomic fact capture cheap. Whether a real model **acts** on the report
or prefers `remember_facts` can only be shown with model calls. No new evaluation is designed here.
