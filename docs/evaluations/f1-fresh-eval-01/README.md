# F1-FRESH-EVAL-01 — does structured fact freshness change downstream decisions? (prepared 2026-10-01, revision 2)

Status: **PREPARED, NOT RUN. No paid call has been made.** `real/` holds only the prepared configuration. `fake-run/` is
the zero-cost dry run with the deterministic fake model.

Code: `src/fleet/eval/f1-fresh-eval-01.ts` and the hardened driver `src/fleet/eval/f1-eval-02-driver.ts`
(`--evaluation f1-fresh-eval-01`). Tests: `src/__tests__/fleet/fleet-f1-fresh-eval-01.test.ts`. The sealed F1-EVAL-02
evidence is untouched.

**The comparison:** FRESH's structured lifecycle against the **best realistic legacy string memory**, not against a
legacy store that cannot correct anything.

## Pre-registration (fixed before any paid call)

`PRE_REGISTRATION_SHA256` = **`65b864c77915cb1347a65ca28643806c4f5edb69134e228453fe24544c69f68c`**. It is the sha256 of
the decision rule, answer key, probe text, trunk, scoring rules, the system-prompt hash and the legacy overwrite
formats. It is recorded in `real/config.json`; a test fails if code and record differ. Revision 1 (`be6aeb8e…`) is
superseded and was never run.

### Shared trunk

The trunk is deterministic and makes no model calls. Every probe starts severed: there is no provider history, only
the packet plus the task.

| Time (UTC) | Intent | Kind |
|---|---|---|
| 09-20 09:00 | goal g1 set (O7 listing test) | |
| 09-20 09:05 | `o7_status` "Goal g1 is OPEN: … still running." | |
| 09-20 09:10 | `o7_price` "O7 single-template price: £12.00." | |
| 09-20 09:12 | `stallhub_fee_rate` "Stallhub transaction fee: 6.5% of each sale." | |
| 09-20 09:15 | `printing_cost` "Printed unit cost: £2.00 at the PrintCo list price." | |
| 09-22 14:00 | `printco_discount` "PrintCo bulk discount 30%: printed unit cost £1.40." | |
| 09-28 17:00 | goal g1 complete ("4 sales in two weeks": no price or fee in it) | |
| 09-28 17:05 | `o7_result` supersedes `o7_status` | KNOWN correction |
| 09-29 10:00 | `price_o7` "O7 single-template price: £13.50." — old key untouched | UNLINKED update |
| 10-01 08:00 | `fee_rate_stallhub` "Stallhub transaction fee: 9% of each sale." — old key untouched | UNLINKED update |
| 10-01 08:30 | `printco_discount` retracted ("PrintCo confirmed that no bulk discount exists …") | KNOWN correction |

The two kinds of update:
- **KNOWN corrections:** the founder knows the old fact is wrong. FRESH uses `supersedes` or `retract_fact`.
  LEGACY does what the old store physically could with the same knowledge: it overwrites the old key's string with
  `SUPERSEDED by <key>: <value>` or `RETRACTED: <reason>`. Both arms remove the wrong value from current memory, so
  these are **parity guards**.
- **UNLINKED updates:** the founder records a newer observation under a new key and leaves the old one. That is the
  F1-EVAL-02 failure mode, and it is identical in both arms. The old and new facts are worded identically except for
  the value, so only F1-FRESH-01's `observedAt` can tell them apart. These are the **discriminating cases**.

### Arms (identical task, trunk intents, system prompt and tool definitions)

| Arm | Memory semantics | Packet |
|---|---|---|
| FRESH | production fact store: current facts, `observedAt`, provenance, lifecycle history | production `buildTaskPacket` |
| LEGACY | one `Record<string,string>`. `remember` overwrites; `supersedes` overwrites the old key with the pointer string; `retract_fact` overwrites with `RETRACTED: …`; no source, history or metadata. `recall_facts` returns the production shape without metadata. | production packet without the three fields F1-FRESH-01 added |
| NOMEM | none | none |

**Tool surface:** every arm gets the **production routed T2 prefix**. The system prompt is `FOUNDER_CHARTER` +
`FOUNDER_ROUTED_ADDENDUM`; the tools are the 17 founder tools + `routine_task` + `escalate_question` + the 5
experiment tools, 24 in all, with byte-identical definitions (tested). LEGACY executes the same tools with string
semantics. This removes the tool-count confound of revision 1 (17 vs 16). The cognition and experiment tools are
advertised but not served in the harness: a call to them is refused and recorded, the same in every arm.

### Probe

The probe has four closed numeric questions. The model must end its answer with
`ANSWERS: q1=…; q2=…; q3=…; q4=…`.

| Q | Asks | Role | Correct | Stale | Retracted |
|---|---|---|---|---|---|
| q1 | O7 single-template price £ | discriminating (unlinked) | 13.50 | 12.00 | — |
| q2 | Stallhub fee % | discriminating (unlinked) | 9 | 6.5 | — |
| q3 | printed unit cost £ | parity guard (known retraction) | 2.00 | — | 1.40 |
| q4 | margin of the £15 two-unit bundle, 15 − 15·fee − 2·cost | discriminating (via q2) | 9.65 | 10.025 | 10.85 (11.225 = both) |

**What replaced the old q1.** Revision 1 asked for the listing-test sales count, but the completed goal's outcome showed
that number in every arm. The new q1 is an unlinked price update: no goal, note or outcome mentions either price
(tested).

**Scoring rules:**
- The last `ANSWERS` line wins.
- Quotes, markdown and trailing punctuation are stripped; £/$/% are accepted.
- Tolerances: q1 ±0.005, q2 exact, q3 ±0.005, q4 ±0.02.
- UNKNOWN, other and missing are separate classes.

### Decision rule

12 answers per arm. The thresholds are unchanged from revision 1.

- **Validity:** at least 8 of 9 parseable cells.
- **Negative control:** NOMEM gets at most 1 correct.
- **FRESH pass:** at least 10 correct, 0 retracted-use and at most 1 stale-use answers.
- **Discrimination:** FRESH correct − LEGACY correct ≥ 3, **and** (LEGACY stale+retracted) − (FRESH stale+retracted)
  ≥ 2.
- **Verdict:** PROVEN if all four hold; NOT_PROVEN if validity and the control hold but FRESH pass or discrimination
  fails; INCONCLUSIVE otherwise.

## Production alignment

- **Model and settings:** T2 `claude-sonnet-5-5`, adaptive thinking, effort medium, **`max_tokens` 8,000** — the live
  tier values. Revision 1 used 4,000. The change raises only the per-call worst-case bound (about $0.147), not the
  expected cost, so it adds realism at no experimental cost.
- **Prices:** from the live tier: 200 / 1,000 / 250 / 20 USD µ¢ per token (input / output / cache write / cache read).
- **Prompt cache:** off (production's evidenced-reuse rule would not cache a one-off probe).

## Dry run (`fake-run/`, deterministic fake model, zero cost)

The fake model takes, per question, the matching fact with the **latest `observedAt`** when the packet carries
freshness, otherwise the **first match** in packet order. Overwritten SUPERSEDED/RETRACTED strings never match. It
proves the instrument separates the arms for the intended reason; it says nothing about a real model.

| Cell | q1 | q2 | q3 | q4 |
|---|---|---|---|---|
| P-FRESH-1/2/3 | correct | correct | correct | correct |
| P-LEGACY-1/2/3 | stale (12.00) | correct* | correct | correct* |
| P-NOMEM-1/2/3 | unknown | unknown | unknown | unknown |

\* The newer fee key happens to sort first in the legacy packet, so the naive first-match is right by order, not by
knowledge.

Totals: FRESH 12/12; LEGACY 9 correct, 3 stale; NOMEM 12 unknown. Instrument verdict PROVEN. The driver accounted for
16,779,600 µ¢ of simulated cost; nothing was billed.

## Budget and projection

There are 9 probe cells with at most 3 calls each. A first request measures about 24.8 KB (FRESH), 24.6 KB (LEGACY)
and 21.5 KB (NOMEM) under the production prefix. Calibrated against production's slim wake (9,312 tokens with a 2.8 KB
packet), that is about 9.6k / 9.6k / 8.7k input tokens.

- **Calls:** 9–27, most likely about 18.
- **Tokens:** about 175k input and about 15k output expected (upper about 280k input and 40k output).
- **Expected cost:** about **$0.50** (range $0.40–$1.00).
- **Hard cap: $1.50** (`capMicrocents` 150,000,000). The driver refuses a config above it and the remote runner refuses
  a budget above it. Every call is refused before it is sent unless its worst case still fits.

## How to run it later (each step needs owner approval; nothing below has been run)

1. Commit and push, then stage the root-owned evaluation tree at `/opt/automaton-fleet/eval/f1-fresh-eval-01` on the
   VPS, as for F1-EVAL-02.
2. `pnpm tsx src/fleet/eval/f1-eval-02-driver.ts run --evaluation f1-fresh-eval-01 --out docs/evaluations/f1-fresh-eval-01/real`
3. `pnpm tsx src/fleet/eval/f1-eval-02-driver.ts score --evaluation f1-fresh-eval-01 --out docs/evaluations/f1-fresh-eval-01/real`
4. Seal: `real/SHA256SUMS` + `real/CLOSED`.
