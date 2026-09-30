# R24 — Opportunity → Experiment Pipeline (2026-09-30)

Status: **implemented and tested locally** (schema v24), with the architect's corrections applied (relevance separate
from provenance, E4 lineage, non-authoritative simulated ROI, and **autonomous evidence relevance**: a controller-owned
independent assessor instead of an owner gate). Financially inert: every amount is simulated,
and no path reaches ledger postings, payment orders or instructions, custody or the owner sweep.

## Core invariant

A founder may **propose** an experiment, cite evidence with a relevance claim, start an approved experiment and report
what it did. It never decides one. FleetController (deterministic SQL) or the owner decides: approve, partially approve,
WATCH or reject. Only the controller or the owner writes the authoritative result, and a founder cannot change its
budget, its maximum loss, the evidence level it is credited with, the relevance of its evidence, the result, the risk
rules or reproduction eligibility. Cognition routing is unchanged, so an experiment's history or wealth never selects a
model tier.

A failed or stopped experiment is recorded exactly like a success: an immutable result, a strategy-registry entry and a
knowledge proposal (category `failure`). The owner still decides what becomes institutional knowledge.

## State machine (`fleet_experiments_guard`)

```
                    ┌──────────► watch ──────────┬──► proposed (owner's queue: irreversible / E4)
proposed ───────────┼──────────► rejected         ├──► rejected
   │                └──► approved / partially_approved   ├──► approved / partially_approved ──► running ──► succeeded
   └──► expired (proposal TTL)                    └──► expired                    │                ├──► failed
                                    approved / partially_approved ──► expired / rejected           └──► stopped
```

- Only these edges are allowed. `rejected`, `stopped`, `succeeded`, `failed` and `expired` are terminal and immutable.
- Rows are created only in `proposed`. The proposal fields never change after insert.
- Entering `approved`, `partially_approved`, `watch` or `rejected` requires `decided_by = 'controller'` or
  `operator:<id>`. An operator decision also passes `fleet_require_operator_approver`, so no principal decides for itself.
- **watch → proposed** is taken by the controller only. It happens when evidence becomes relevant but the decision
  belongs to the owner (irreversible, or E4).
- An approved budget never changes, and simulated spend never decreases. The following CHECKs hold:
  `sim_spent ≤ approved`, `approved ≤ requested`, `approved max loss ≤ approved` and `max loss ≤ requested`.
- Every table changes only inside an experiment function (`fleet.experiment_op`). Transitions, events, relevance
  assessments, revenue attributions, results and the registry are append-only (`fleet_history_immutable`).

## Evidence: provenance is not relevance

**Provenance** is checked by the controller against its own research record
(`fleet_experiment_verify_evidence`). The attempt must be this founder's authorized, fetched page, and the cited sha256
must equal the recorded `content_sha256`. It proves the founder really fetched that page unaltered. It says nothing
about whether the page supports the proposal.

### Evidence artifacts (at research-fetch time)

When a page is fetched, the controller keeps a bounded, sanitized **evidence artifact** in
`fleet_research_evidence_artifacts`, written by `svc_research_artifact_record` from `src/fleet/research/artifact.ts`.

What the artifact holds:

- the research attempt id, the page hash (equal to the research result's `content_sha256`), the host of the recorded
  final URL, and the registry's own fetch timestamp;
- at most 6000 characters of normalized extracted text: never the raw page or HTML;
- the excerpt's own sha256, source length, a truncation flag and a redaction count.

How it is sanitized and checked:

- **Normalization:** NFKC, control and invisible characters removed, whitespace collapsed.
- **Redaction:** the canonical redaction runs over the first 8000 characters before the cut, so a secret starting inside
  the excerpt is removed whole. The registry's own secret shapes are also neutralized.
- **Fail closed:** if anything credential-shaped remains, no artifact is kept.
- **Registry refusals:** a hash mismatch, a host mismatch, another founder's or an unfetched attempt, an oversized or
  secret-shaped excerpt, or a duplicate.
- **Immutable** once written. The agent role cannot read the table.

This applies to every fetch once v24 is deployed, even while the pipeline is off, so pages fetched before enabling can
be judged later. Worst case is about 19 MB a day at the fleet research quota.

### The independent relevance assessor (FleetController)

`src/fleet/experiments/relevance.ts` runs on the controller:

- once after every accepted `propose` or `add_evidence` (off the request path);
- on every reaper tick;
- single-flight in both cases.

Its work list comes from `svc_experiment_relevance_pending`. Each job holds:

- the cited item: attempt, page hash and claimed support category;
- the proposal's hypothesis, objective, reversibility and amount relative to the E2 cap;
- the artifact.

It carries **no founder id, wealth, history or ROI**. The founder's own rationale is not shown to the model either.

| Step | Cognition | Rule |
|---|---|---|
| No artifact, or artifact for another page hash | **T0** (software, no model) | `uncertain` |
| Normal judgement | **T2** (task class `evidence_relevance`, router v22) | the model returns stance, category, verbatim quotes and a reason |
| T2 answered ambiguous/conflicting/unusable | one question-scoped **T3** escalation (`EVIDENCE_CONFLICT` / `LOWER_TIER_INSUFFICIENT`) | T3's answer is final |
| Consequential proposal: irreversible, or requested above the E2 cap | **T3** directly (`IRREVERSIBLE_ACTION` / `HIGH_CONSEQUENCE`) | — |

T1 is not used. The deterministic checks are exact software (T0), and a relevance judgement is not a routine chore.

**Deterministic reduction** of the model's answer to a verdict:

- **`relevant`** only if the model says the page supports *exactly the claimed category* and gives ≥1 quote that is
  verbatim in the artifact.
- **`irrelevant`** if the page does not bear on the claim.
- **`uncertain`** for contradicting or mixed pages, a different category, no verifiable quote, or an unusable answer.

The page and the proposal are delimited as untrusted data in the prompt.

**Recording** (`svc_experiment_relevance_record`):

- One immutable controller row per item, with the tier, the artifact's excerpt hash, the quotes and a concise reason.
- The registry **re-checks** that a `relevant` verdict cites the artifact of the same page hash and that every quote
  occurs verbatim in it. Otherwise it refuses (`FLEET_RELEVANCE_UNVERIFIED`), whoever sent it.
- Each model call is recorded as **provider-credit consumption**. This is fleet overhead: no ledger posting, no charge
  to the founder. It is recorded even when the verdict is refused, and is bounded by
  `relevance_max_calls_per_hour` (60).
- The controller then re-derives the level and **re-decides**.

**Controller decision path:**

- While any cited item is unassessed, the proposal stays on WATCH (`FLEET_RELEVANCE_PENDING`).
- **Any `uncertain` item keeps the proposal on WATCH** (`FLEET_EVIDENCE_UNCERTAIN`), whatever the other items are
  worth. Uncertain never earns a level and never auto-approves. The founder can add evidence, and nothing goes to the
  owner unless it is owner-authority work (irreversible, E4).

**Owner override (optional, audited):** `fleet:admin experiment-relevance <exp> <attempt> relevant|irrelevant|uncertain
<reason…>` adds one owner row per item, recording the controller verdict it overrides. It emits
`experiment_relevance_overridden`. It is allowed only before the decision and never for the founder's own identity. The
effective verdict is the override if present, else the controller's. Ordinary evidence never needs it.

## Evidence Ladder (`fleet_evidence_ladder`)

The caps are **simulation-only**: `cap_scope` is CHECK-pinned to `simulation_only`, and the columns are commented
"not an approved real-money limit". The architect kept E0–E3 and the 5000 hard cap for simulation. They are not future
real-money limits.

| Level | Code | Verified when (relevant = provenance-verified **and** assessed relevant) | Auto cap (simulated) |
|---|---|---|---|
| E0 | `claim` | the founder's assertion, or no relevant item | 0, so the proposal goes to WATCH |
| E1 | `desk_single` | ≥1 relevant item | 300 |
| E2 | `desk_corroborated` | ≥2 relevant items from ≥2 distinct hosts | 1000 |
| E3 | `observed_signal` | E1, plus an earlier **succeeded** controller result of this founder on the same opportunity | 2500 |
| E4 | `revenue` | E3, plus revenue attributed to this opportunity's lineage (below) | none: the owner decides |

E3 still needs relevant evidence for the *new* proposal, because a founder chooses its own opportunity key.

### E4 lineage (`fleet_opportunity_revenue_attributions`)

Generic positive revenue of a founder is not evidence for any particular opportunity. E4 counts only revenue attributed
to the same opportunity, recorded by `fleet_experiment_attribute_revenue`, an owner function that reads the ledger and
never posts to it. The attributed journal must satisfy all of the following:

- it is an `external_revenue` journal of the same founder;
- it was recorded after the target experiment started;
- the target experiment has concluded (the lineage is that experiment's opportunity);
- it has not been reversed.

Each journal is attributable once, and the amount is what the journal credited to the founder's revenue account. The
founder cannot attribute its own revenue. A later reversal of the journal removes its E4 effect.

## Deterministic evaluation (`fleet_experiment_evaluate`)

The checks run in this order, and the first one that matches decides:

1. Requested amount above `hard_cap_minor` (default 5000, simulation-only): **rejected** (`FLEET_EXPERIMENT_OVER_CAP`).
2. Any cited item still unassessed: **watch** (`FLEET_RELEVANCE_PENDING`).
3. Any cited item uncertain: **watch** (`FLEET_EVIDENCE_UNCERTAIN`).
4. Verified level E0: **watch** (`FLEET_EVIDENCE_INSUFFICIENT`).
5. No survival headroom: **rejected** (`FLEET_PROTECTED_CAPITAL`). Headroom is `expensePurchasingCapacity` minus the
   **whole approved maximum loss** of the founder's other active experiments. Founder-reported simulated spend never
   releases headroom (corrected in this revision).
6. Irreversible, or a level with no cap (E4): the **owner decides** (`FLEET_OWNER_DECISION_REQUIRED`).
7. Budget is `LEAST(requested, cap)` and max loss is `LEAST(max_loss, budget, headroom)`. If either was reduced, the
   result is **partially_approved**; otherwise it is **approved**.

## Simulated ROI is non-authoritative

- Results and registry rows store `simulated_roi`, with `roi_authority` CHECK-pinned to `'simulated_non_authoritative'`.
  Results also store `spend_source` pinned to `'founder_reported_simulated'`. Output and knowledge text label it
  "simulated ROI (non-authoritative)".
- Nothing decides on it. It is not an input to capital allocation, headroom, the evidence level (E3 uses the
  controller-decided outcome), confidence (derived from outcome and level), reproduction eligibility or any ranking.
- The privilege audit fails if any function other than `fleet_experiment_conclude_internal`, `fleet_experiment_json`
  or `api_experiment_list` names `simulated_roi`. Test (18) proves this with a rogue ranking function.
- Future authoritative ROI must use ledger-backed spend and controller-attributed revenue. That needs a new schema
  version and an architecture review.

## Running and concluding

- `start` is allowed only before the approval expires. After that the experiment moves to `expired`
  (`FLEET_APPROVAL_EXPIRED`). The run deadline is `min(max_run_s, max(2 × time_to_signal, 1 h))`.
- `record` accepts `sim_spend`, `step`, `observation` and `result_claim`. Each is idempotent per key: a replay returns
  `FLEET_DUPLICATE_EVENT`, and different content under the same key returns `FLEET_IDEMPOTENCY_CONFLICT`. Spend beyond
  `LEAST(approved, approved max loss)` is refused (`FLEET_BUDGET_EXCEEDED`). A claim after conclusion is refused
  (`FLEET_RESULT_AUTHORITATIVE`). Secret-shaped text is refused.
- Stop conditions move the experiment to `stopped`: max loss reached, run window elapsed, `spend_at_least`,
  `elapsed_at_least_s`, or a metric threshold. Metric thresholds fire on any observation, because stopping is
  conservative.
- **Authoritative criteria use only `controller_recorded` observations** (owner `experiment-observe`, or a
  controller executor). Founder observations are kept and listed as discrepancies.
- Conclusion (owner conclude or stop, a stop condition, or the reaper) writes one result, one registry entry, one
  knowledge proposal and the transition.

## Inert mode

- `fleet_experiment_policy.enabled = false` after migration. The founder API returns `FLEET_EXPERIMENTS_DISABLED`, and
  the tools are not advertised (`capabilities.experimentsEnabled`).
- `financial_mode` is CHECK-pinned to `'simulated'` on the policy, results and registry. The privilege audit fails if an
  experiment function calls `fleet_ledger_post(…)` or touches payment orders or instructions, `fleet_order_*` or
  `fleet_admin_*`. The agent role executes only the five `api_experiment_*` functions, and the service role only
  `svc_experiment_reap`.

## Surfaces

| Layer | Additions |
|---|---|
| SQL (v24) | 10 tables (policy, ladder, evidence artifacts, experiments, transitions, events, relevance, revenue attributions, results, registry), guards, evaluation, founder API, service (`svc_experiment_reap`, `svc_research_artifact_record`, `svc_experiment_relevance_pending`, `svc_experiment_relevance_record`), owner functions (`fleet_experiment_{policy_set,decide,assess_relevance,attribute_revenue,observe,stop,conclude,view}`, `fleet_evidence_ladder_set`) |
| FleetController HTTP | `POST /v1/experiments/{propose,evidence,start,record,list}` (session auth; not a witness route); research fetch keeps the evidence artifact; the relevance assessor runs after propose/evidence and on the reaper tick |
| Founder runtime (R24-2, later) | toolbox cases and client methods for the five tools. Evidence items require `supports` and `rationale` |
| Owner CLI (`fleet:admin`) | `experiment-policy`, `experiment-enable` / `-disable`, `evidence-ladder-set`, `experiment-list`, `experiment-show`, `strategy-registry`, `experiment-decide`, **`experiment-relevance`** (optional override), **`experiment-attribute-revenue`**, `experiment-observe`, `experiment-stop`, `experiment-conclude` |

## Remaining review items

1. **Relevance is not credibility.** The assessor judges whether a page supports the claim, not whether its source is
   trustworthy. A founder could fetch a page it arranged to exist, such as a public paste. Caps are small and simulated,
   and E2 needs two hosts. Source credibility is future work.
2. **Prompt injection.** Page text is delimited untrusted data. A `relevant` verdict needs verbatim quotes that the
   registry re-checks, and consequential proposals use T3. A page written to persuade a model can still sway a judgement.
3. **Provider failures.** If the first (T2) call fails, the item stays pending and is retried on the next pass. The
   hourly budget bounds retries. A failed call the provider still billed is not recorded (small accounting gap).
4. **Artifacts start accumulating at deploy**, even with the pipeline off: bounded, sanitized, and readable only by the
   owner and controller roles. There is no retention sweep yet.
5. **The assessor's inference is fleet overhead** in the provider-credit record, not charged to a founder.
6. **A founder can end its own experiment early** (metric or max-loss stop). The outcome is then `stopped`, which is
   conservative.
7. **A founder runtime upgrade is required** for Founder 1 to use the tools (R24-2). It also activates the pending
   R23.1 slim wake packet.
