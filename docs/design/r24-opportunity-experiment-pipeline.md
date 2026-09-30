# R24 — Opportunity → Experiment Pipeline (2026-09-30)

Status: **implemented and tested locally** (schema v24), with the architect's three corrections applied (relevance
separate from provenance, E4 lineage, non-authoritative simulated ROI). Financially inert: every amount is simulated,
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

**Relevance** is a separate, explicit record:

- Every cited item must carry the founder's relevance **claim**: `supports` (one of `problem`, `demand`,
  `willingness_to_pay`, `channel`, `competition`, `feasibility`, `cost`) and a `rationale` (10–300 chars). The claim
  is stored with the verified item and is never trusted.
- The item counts only after an **assessment** in `fleet_experiment_relevance`: one immutable row per (experiment,
  item). The row references the research attempt and the page hash that verified its provenance, and records the claimed
  `supports`, the verdict (`relevant` or `irrelevant`), the assessor and a reason.
- In R24 the assessor is the **owner** (`fleet:admin experiment-relevance`). It is never the founder:
  `fleet_require_operator_approver` refuses the founder's own identity. The controller cannot judge relevance itself,
  because the registry stores page hashes, not page text.
- The controller decides only on a **complete** relevance record. While any cited item is unassessed, the proposal
  stays on WATCH (`FLEET_RELEVANCE_PENDING`), so the order of assessments can never size a budget. When the last item
  is assessed, the controller re-evaluates deterministically. The assessment is an input to the controller's decision,
  not an approval.
- Relevance is assessed only before the decision (`proposed` or `watch`). Each item is assessed once, and only items
  the proposal cited can be assessed.

## Evidence Ladder (`fleet_evidence_ladder`)

The caps are **simulation-only**: `cap_scope` is CHECK-pinned to `simulation_only`, and the columns are commented
"not an approved real-money limit". The architect kept E0–E3 and the 5000 hard cap for simulation. They are not future
real-money limits.

| Level | Code | Verified when (relevant = provenance-verified **and** assessed relevant) | Auto cap (simulated) |
|---|---|---|---|
| E0 | `claim` | the founder's assertion, or only unassessed or irrelevant items | 0, so the proposal goes to WATCH |
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
3. Verified level E0: **watch** (`FLEET_EVIDENCE_INSUFFICIENT`).
4. No survival headroom: **rejected** (`FLEET_PROTECTED_CAPITAL`). Headroom is `expensePurchasingCapacity` minus the
   **whole approved maximum loss** of the founder's other active experiments. Founder-reported simulated spend never
   releases headroom (corrected in this revision).
5. Irreversible, or a level with no cap (E4): the **owner decides** (`FLEET_OWNER_DECISION_REQUIRED`).
6. Budget is `LEAST(requested, cap)` and max loss is `LEAST(max_loss, budget, headroom)`. If either was reduced, the
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
| SQL (v24) | 9 tables (policy, ladder, experiments, transitions, events, relevance, revenue attributions, results, registry), guards, evaluation, founder API, reaper, owner functions (`fleet_experiment_{policy_set,decide,assess_relevance,attribute_revenue,observe,stop,conclude,view}`, `fleet_evidence_ladder_set`) |
| FleetController HTTP | `POST /v1/experiments/{propose,evidence,start,record,list}` (session auth; not a witness route) |
| Founder runtime (R24-2, later) | toolbox cases and client methods for the five tools. Evidence items require `supports` and `rationale` |
| Owner CLI (`fleet:admin`) | `experiment-policy`, `experiment-enable` / `-disable`, `evidence-ladder-set`, `experiment-list`, `experiment-show`, `strategy-registry`, `experiment-decide`, **`experiment-relevance`**, **`experiment-attribute-revenue`**, `experiment-observe`, `experiment-stop`, `experiment-conclude` |

## Remaining review items

1. **The owner is the relevance assessor.** Once the pipeline is enabled, every automatic decision waits for owner
   assessments. A future controller-side assessor, independent of the founder, would be an architecture change.
2. **A founder can end its own experiment early** (metric or max-loss stop). The outcome is then `stopped`, never
   `succeeded`, which is conservative.
3. **A founder runtime upgrade is required** for Founder 1 to use the tools (R24-2). It also activates the pending
   R23.1 slim wake packet.
