# F1-FRESH-EVAL-02 — does structured freshness help the founder use CURRENT truth? (prepared 2026-10-01)

Status: **PREPARED, NOT RUN.** No paid call has been made; `real/` holds only `config.json`. `fake-run/` is the
zero-cost dry run.

F1-FRESH-EVAL-01 stays sealed and **NOT_PROVEN**. This is a new evaluation, not a rerun. Its one design lesson: that
evaluation's discrimination rule required LEGACY to *use stale values*, but the real LEGACY founder abstained
(UNKNOWN) instead. Abstention is safe, but it is not knowing the current truth. This evaluation therefore measures
**current-truth accuracy**. Stale use is reported but is never a required condition.

**Hypothesis:** structured freshness improves the founder's ability to identify and use **current** truth after
memory contains multiple historically valid but conflicting observations.

Code: `src/fleet/eval/f1-fresh-eval-02.ts`, run through the hardened driver `src/fleet/eval/f1-eval-02-driver.ts`
(`--evaluation f1-fresh-eval-02`) and the remote entry point `f1-eval-02-main.ts`. Tests:
`src/__tests__/fleet/fleet-f1-fresh-eval-02.test.ts`.

## What is new compared with F1-FRESH-EVAL-01

| | F1-FRESH-EVAL-01 | F1-FRESH-EVAL-02 |
|---|---|---|
| Memory | written by a scripted trunk (no model) | **written by the model** in three news turns (model-driven trunk) |
| Domains | 4 questions, 2 discriminating | **10 questions**: 6 changing fact domains, 2 derived decisions, 2 unchanged controls |
| Update kinds | unlinked update, retraction | explicit correction, unlinked newer observation, retraction, unchanged control |
| Primary measure | correct answers **and** stale-use advantage | **current-truth accuracy only** |
| Answers per arm | 12 | **30** (24 changing + 6 control) |
| Maintenance vs representation | not separable | **measured separately** |
| Hard cap | $1.50 | **$2.00** |

## The world (identical in every arm)

Every turn is **severed**: there is no provider history, only the task packet built from the arm's memory plus the
turn's news. Whatever the founder does not store is lost. The news never mentions fact keys.

| Turn | News |
|---|---|
| 1 (09-20) | price £12.00; fee 6.5%; printed unit cost £2.00; paper in stock; lead time 5 business days; refund within 14 days; quota 20 listings/month; cost per click £0.35 |
| 2 (09-24) | a forum post claims a 30% PrintCo bulk discount (unit cost £1.40); Stallhub **explicitly corrects** the fee: "6.5% is out of date; the fee is 9%" |
| 3 (09-29) | listed at £13.50; lead time now 12 business days; refund window now 30 days; PrintCo: **no bulk discount, the forum post was wrong**; paper out of stock until 2026-10-20 |

Turn 3 restates the price, lead time and refund window without saying that the old values are wrong. These are
**unlinked newer observations**: only the date tells them apart, and it is up to the founder to maintain them.

## Probe (2026-10-01, severed, from memory only)

The founder must end with `ANSWERS: q1=…; …; q10=…`. Each value may be UNKNOWN.

| Q | Asks | Update kind | Current | Stale | Retracted |
|---|---|---|---|---|---|
| q1 | price £ | unlinked newer observation | 13.50 | 12 | — |
| q2 | fee % | explicit correction | 9 | 6.5 | — |
| q3 | paper IN/OUT | change | OUT | IN | — |
| q4 | lead time, business days | change | 12 | 5 | — |
| q5 | refund window, days | change | 30 | 14 | — |
| q6 | printed unit cost to use £ | claim later retracted | 2.00 | — | 1.40 |
| q7 | listing quota | **unchanged control** | 20 | — | — |
| q8 | cost per click £ | **unchanged control** | 0.35 | — | — |
| q9 | net margin of a £15 two-unit bundle | decision (q2, q6) | 9.65 ±0.02 | 10.025 | 10.85; both 11.225 |
| q10 | can paper ordered today arrive within 10 business days? | decision (q3, q4) | NO | YES | — |

**Classes:** CURRENT_CORRECT, STALE, RETRACTED, STALE+RETRACTED, UNKNOWN, OTHER, MISSING.
- The last ANSWERS line wins.
- Quotes, markdown and trailing punctuation are stripped.
- £/$, %, and unit words (days, listings) are accepted; tokens are case-insensitive.

## Arms (identical system prompt, tool definitions, news, probe and step limits)

| Arm | Memory | Packet |
|---|---|---|
| FRESH | production F1-FRESH-01 fact store: `observedAt`, source, same-key supersession, `supersedes`, `retract_fact`, history | production `buildTaskPacket` |
| LEGACY | **best realistic legacy**: a `Record<string,string>`. The same tools are executed with string semantics: `supersedes` and `retract_fact` overwrite the old key with `SUPERSEDED by …` / `RETRACTED: …` (the strongest correction the old store could express) | production packet without the F1-FRESH-01 fields |
| NOMEM | none: no trunk; the probe only | none |

- Every arm uses the **production routed T2 prefix** (`FOUNDER_CHARTER` + `FOUNDER_ROUTED_ADDENDUM`, 24 tools,
  byte-identical definitions, reused from F1-FRESH-EVAL-01).
- Every arm runs the production `FounderMind` and `FounderToolbox`.
- Production step limits apply: 4 steps per trunk turn (production's default `maxStepsPerTurn`) and 3 for the probe.
- At most `MAX_TOOL_CALLS_EXECUTED` (5) tool calls run per step. Excess calls are answered `FLEET_TOOL_CALL_LIMIT`,
  exactly as in production. The cell records them; they are never counted as maintenance.

## Representation versus maintenance

The model's maintenance is recorded from the memory after the trunk and from the tools it actually executed:
`remember_fact` calls, `remember_fact` with `supersedes`, and `retract_fact`.

**Memory state.** Each changing domain q1–q6 and each control is classified from the current fact texts after the
trunk, using the pre-registered detectors:

| State | Meaning |
|---|---|
| CLEAN | the current value is present and no stale-only fact remains |
| AMBIGUOUS | the current value and a stale value are both current |
| STALE_ONLY | only a stale value is current |
| MISSING | the domain is absent |

A fact that negates the retracted claim ("no bulk discount", "wrong") does not assert it.

**The two effects (descriptive, reported beside the verdict):**
- **Maintenance effect:** the share of CLEAN domains per memory arm (FRESH vs LEGACY). It shows whether the richer
  tools led the model to keep memory clean.
- **Representation effect:** current-truth accuracy on answers whose domain was **AMBIGUOUS** in that cell's memory,
  FRESH − LEGACY, reported when both arms have at least 3 such answers. It shows whether freshness metadata lets the
  model pick the current value when conflicting facts coexist.
- **Abstention:** UNKNOWN counts per arm, reported separately from STALE and RETRACTED.

## Pre-registered decision rule

`PRE_REGISTRATION2_SHA256` = **`90a7674339ea1f2ff78f95ac7948c827bc61ccfa6bfbd975c075a0c3b1a3316a`**. It is the
sha256 of:
- the rule, answer key and memory detectors;
- the trunk news, probe text and scoring rules;
- the system-prompt hash.

It is recorded in `real/config.json` and `fake-run/config.json`, and a test fails if code and record differ.

**Primary measure:** current-truth accuracy (CTA), the CURRENT_CORRECT count over the 8 changing answers (q1–q6,
q9, q10) × 3 replicates = **24 per arm**.

| Check | Rule |
|---|---|
| Validity | ≥ 8 of 9 cells parsed, and ≥ 6 of 6 memory-arm trunks complete |
| Negative control | NOMEM CTA ≤ 2, and NOMEM controls correct ≤ 1 |
| Retention | each memory arm gets ≥ 4 of 6 control answers right |
| FRESH quality | FRESH CTA ≥ 18 / 24 |
| Superiority | FRESH CTA − LEGACY CTA ≥ 6, **and** FRESH wins ≥ 2 of the 3 replicate pairs |

**Verdicts:**
- **PROVEN:** all five checks hold.
- **NOT_PROVEN:** validity, negative control and retention hold, but FRESH quality or superiority fails.
- **INCONCLUSIVE:** validity, negative control or retention fails. That is an instrument failure, not evidence
  about the hypothesis.

**Why these thresholds (derived from the instrument, not from F1-FRESH-EVAL-01's 12/12 vs 3/12):**
- **Superiority advantage.** With n = 24 per arm and p ≈ 0.7, the standard error of a difference of two proportions is
  √(2·0.7·0.3/24) ≈ 0.13. A required advantage of 0.25 (6 answers) is therefore about 1.9 SE, roughly a one-sided
  α ≈ 0.03 under independence.
- **Replicate pairs.** Answers within a cell share one trunk and are correlated. The advantage must therefore also
  appear in at least 2 of 3 independent replicate pairs, so one lucky trunk cannot carry it.
- **FRESH quality (18/24 = 75%).** It requires FRESH to be usefully right, not merely better than LEGACY. It is
  deliberately below perfection because a model-written memory can legitimately drop a fact.
- **Retention (4/6).** It rejects a run where memory as a whole failed, which would make a CTA comparison meaningless.
- **Negative control.** NOMEM cannot know any of these values. Two lucky CURRENT_CORRECT answers are tolerated
  (e.g. q10 = NO by caution), and the control answers must stay unknown.
- **Stale use is not required.** A LEGACY founder that abstains loses on CTA exactly as one that uses stale values
  (tested).

## Dry runs (deterministic fake founders, zero cost)

`FakeFounder2(policy)` reads the news and the packet like a founder would. Each policy runs through the production
mind, toolbox, fact store and packet builder.

| Policy (arm) | q1 q2 q3 q4 q5 q6 q7 q8 q9 q10 | Memory q1–q6 | remember / supersedes / retract |
|---|---|---|---|
| ideal (FRESH, LEGACY) | C C C C C C C C C C | all CLEAN | 14 / 0 / 1 |
| unlinked (FRESH) | C C C C C C C C C C | all AMBIGUOUS | 15 / 0 / 0 |
| unlinked = cautious legacy (LEGACY) | U U U U U C C C U U | all AMBIGUOUS | 15 / 0 / 0 |
| stalePicker = stale legacy (LEGACY) | S S S S S R C C SR S | all AMBIGUOUS | 15 / 0 / 0 |
| — (NOMEM) | U U U U U U U U U U | — | — |
| partial (FRESH) | C C U C C C U U C U | q3 MISSING; q7, q8 MISSING | 8 / 0 / 0 |
| wrongMaintain (FRESH, LEGACY) | S S S S S U C C U S | all STALE_ONLY | 20 / 6 / 1 |
| malformed (FRESH) | M M M M M M M M M M (unparsed) | all CLEAN | 14 / 0 / 1 |

(C current, S stale, R retracted, SR stale+retracted, U unknown, M missing.)

**Full plan through the hardened driver (`fake-run/`, unlinked policy):**
- **Arms:** FRESH CTA 24/24; LEGACY 3/24 (21 UNKNOWN, 0 stale); NOMEM 0/24 (24 UNKNOWN). Controls 6/6, 6/6, 0/6.
- **Instrument verdict:** PROVEN. Representation effect +0.83 (all AMBIGUOUS domains); maintenance effect 0, because
  the fake maintains identically in both arms.
- **Spend:** 100,741,800 µ¢ of simulated spend from synthetic token counts; nothing was billed.

The dry run proves only that the instrument separates the behaviours for the intended reasons. It says nothing
about a real model.

## Budget and projection

**Per replicate (measured from the dry run's request sizes):**
- FRESH and LEGACY: 8 calls each, 23.4–26.5 KB per request.
- NOMEM: 1 call of 21.7 KB.

**Token rate:** calibrated on F1-FRESH-EVAL-01's real calls, 2.576 bytes per input token.

| | Calls | Input tokens | Output tokens | Cost |
|---|---|---|---|---|
| Expected (fake's step pattern) | ~51 | ~490k ($0.98) | ~30k assumed ($0.30) | **≈ $1.30** |
| Plausible range | 45–75 | 440k–720k | 20k–60k | **$1.05–$1.95** |

- **Hard cap: $2.00** (`capMicrocents` 200,000,000). The driver refuses a config above it, and the remote runner
  refuses a cell budget above it.
- **Per-call guard:** every call is refused before it is sent unless its worst case (about $0.15 per call at
  `max_tokens` 8,000) still fits.
- **Cell order:** cells are interleaved by replicate. If spending runs high, a budget stop therefore truncates the
  last replicate, not an arm.
- **Absolute worst case:** 15 calls per memory cell (4 + 4 + 4 + 3) and 3 per NOMEM cell, 99 calls in all. That is
  beyond the cap: the run would stop early and, if validity failed, be **INCONCLUSIVE** (never silently scored).
- **Prompt cache:** off, as in F1-FRESH-EVAL-01.

## How to run it later (each step needs owner approval; nothing below has been run)

1. Commit and push to `fleet-origin`. Stage the root-owned evaluation tree `/opt/automaton-fleet/eval/f1-fresh-eval-02`
   on the VPS from that commit, as for F1-FRESH-EVAL-01. It is built separately from production, and Founder 1 and
   the controller are untouched.
2. `pnpm tsx src/fleet/eval/f1-eval-02-driver.ts run --evaluation f1-fresh-eval-02 --out docs/evaluations/f1-fresh-eval-02/real`
3. `pnpm tsx src/fleet/eval/f1-eval-02-driver.ts score --evaluation f1-fresh-eval-02 --out docs/evaluations/f1-fresh-eval-02/real`
4. Seal: `real/SHA256SUMS` + `real/CLOSED`.

The spend runs on the evaluation key outside fleet metering, as in F1-FRESH-EVAL-01. It must be recorded afterwards
as an owner provider-credit adjustment.
