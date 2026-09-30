# Cognition efficiency and neutral routing — implementation plan (2026-09-30)

Status: **implemented INERT** (see "Activation boundary"). Builds on `docs/design/f1-eval-02-cognition-routing.md`
and the F1-EVAL-02 findings (packet recovery works; 0% cache use; ~46% of input tokens were a fixed prefix).

## Invariant

Cognition capability is selected from the requirements and consequence of the **current task**, never from the
agent's commercial history. Two separate systems:

| System | Question | Inputs it may read | Where |
|---|---|---|---|
| Cognition Router | What capability does this task need to be done reliably? | task class, structured escalation request, consequential-action class | `src/fleet/cognition/router.ts` (pure) + v22 tier table |
| Capital allocator | Does this proposal justify Fleet capital? | the proposal's own evidence/economics (existing spend-order policy) | unchanged (`svc_spend_request`, owner decisions) |

The router's input type has no field for wealth, profit, loss or opportunity count, and it **refuses** any unknown
input key, so history cannot reach it by accident. Budgets and rate limits stay hard circuit breakers only.

## Tiers (semantics stable; model mapping is data)

| Tier | Semantics | Baseline candidate (v22 seed, disabled + unverified) |
|---|---|---|
| T0 | deterministic software, no inference | — (router returns `deterministic`; the gateway never calls a model) |
| T1 | routine: extraction, classification, triage, tagging, formatting | `claude-haiku-4-5-20251001`, no thinking, no effort (unsupported) |
| T2 | standard autonomous work: research, synthesis, validation design, building, multistep tool use | `claude-sonnet-5-5`, adaptive, effort `medium` |
| T3 | critical: conflicting evidence, failure diagnosis, pivots, irreversible/major capital, legal/security, reproduction | `claude-opus-5-5`, adaptive, effort `medium` (`high` only by task) |

Mappings live in `fleet_cognition_tiers` (owner-set; a tier is usable only when **enabled and verified** against the
provider account). Prices per tier are stored with the row and snapshotted into the in-flight reservation, so each
call is charged at its own model's prices.

## Escalate the question, not the job

A lower tier that meets one hard question materialises a **Critical Decision Packet** (`fleet-decision-v1`,
`src/fleet/eval/task-packet.ts` family, provider-neutral): question, objective, relevant state/knowledge, evidence
refs + short excerpts, hypothesis, uncertainty/conflict, economic consequence, policy, output contract, escalation
reason. Never: transcripts, unrelated research, repeated tool output, thinking blocks, signatures. The T3 call is a
fresh single-message conversation; its answer is persisted as observable state; the next ordinary step routes by its
own task class again (control returns downward; one T3 decision never converts the task to T3).

Escalation reason codes (closed set): `EVIDENCE_CONFLICT`, `HIGH_CONSEQUENCE`, `IRREVERSIBLE_ACTION`,
`NOVEL_UNCERTAINTY`, `LOWER_TIER_INSUFFICIENT`, `SECURITY_CRITICAL`, `LEGAL_COMPLIANCE_CRITICAL`,
`REPRODUCTION_DECISION`. Anything else is refused. The router may force a higher minimum from the task class or
the consequential-action class regardless of the request; `LOWER_TIER_INSUFFICIENT` requires a parent request.

## Consequential-action boundary

Routed calls log each tool call's `id`, `name`, `argsSha256` and, for actions, an `actionSha256` over the canonical
action fields. Before a routed founder's spend order, the controller calls `svc_action_cognition_verify`: a log row of
this founder must contain that tool call, with matching action digest, produced within 30 minutes, by a tier ≥ the
action class minimum (`fleet_action_min_tier`, e.g. spend ≥ threshold → T3). Links are single-use. The tier is the
controller's record, never the founder's label, so mislabelling cannot lower it.

## Context and caching

Stable cached prefix (tools + charter; one explicit breakpoint on the last system block) + minimal packet + current
task. Adapter option `promptCache` (`off` default | `prefix` | `prefix+tail`); tail = top-level automatic caching for
the growing tool loop. Thinking/effort are pinned per tier (changing them invalidates caches). Usage instrumented per
call: cache write/read, uncached input, output, cost, and saving vs uncached at list price. Documented minimum
cacheable prompt: Haiku 4.5 4096 tokens (the ~3.8k founder prefix will not cache there; T1 calls use a small prompt and
are never padded), Sonnet 5.5 and Opus 5.5 512 tokens.

## Loop and duplication economics

- Controller (routed path): an identical prompt digest after a non-transient failure within 10 minutes is refused
  before the provider (`FLEET_COGNITION_DUPLICATE_FAILURE`, uncharged).
- Founder runtime (`LoopGuard`, new runtimes): an identical tool call (name + args) that failed is not re-executed
  unless state changed; a URL already saved is not re-fetched within the freshness window (the saved page is
  returned with its provenance); bounded transient retry only.

## Observability (v22 log columns, all nullable for legacy rows)

task_id, task_class, tier, requested_tier, escalation_reason, router_decision, parent_request_id, reasoning (jsonb),
packet_bytes, thinking_tokens, route_version, plus existing provider/model/tokens/cache/cost/GBP/attempts/status.
Owner report: `cognition-report` (per task class × tier: calls, tokens, cache, cost, errors, escalations).
Founders never grade themselves: outcome scoring stays owner/evaluator-only (future table).

## Activation boundary

- v22 schema: additive; routing disabled globally and per founder; tiers seeded disabled/unverified.
- Controller: legacy `infer` path unchanged and used unless routing is enabled globally **and** for that founder.
- Founder 1 (`eea1932`) sends no route/packet; it stays on the legacy path. Moving it would be an owner decision
  (per-founder enable) and changes its model — not done.
- Prompt caching: adapter option, off unless `FLEET_COGNITION_PROMPT_CACHE` is set (it would also apply to the
  legacy path; activation is a separate owner decision after a small real-usage check).
- Activation sequence: deploy (v21→v22) → Models API verification per tier → `cognition-tier-verify` →
  small real check of routing + cache usage → per-founder enable for a **new** founder runtime.

## Verification status of the baseline mapping (2026-09-30)

| Tier | Model ID | Public docs (models overview + pricing, fetched 2026-09-30) | Fleet account (Models API) |
|---|---|---|---|
| T1 | `claude-haiku-4-5-20251001` | valid ID; $1/$5 per MTok (cache write $1.25, read $0.10); extended thinking only (`budget_tokens`), **effort not supported**; 200K context, 64K output; **retirement not sooner than 2026-10-15**; min cacheable prefix 4096 tokens | not yet checked (VPS access needed) |
| T2 | `claude-sonnet-5-5` | valid ID; $2/$10 (cache write $2.50, read $0.20); adaptive thinking; **API default effort `high`** (the mapping sets `medium` explicitly); 1M / 128K | not yet checked |
| T3 | `claude-opus-5-5` | valid ID; $4/$20 (cache write $5, read $0.20); adaptive, always on; default effort `medium`; 1M / 128K | verified 2026-09-29 (F1-EVAL-02 `models.json`) |

Minimum cacheable prompt (current official Anthropic documentation, per FleetAdmin 2026-09-30): Haiku 4.5 **4096**
tokens, Sonnet 5.5 **512**, Opus 5.5 **512**. (An earlier revision of this document said the 5.5 minimums were
unpublished; that was based on an older reference table and is corrected.) So the ~3.8k stable founder prefix is
expected to be too short to cache on Haiku and comfortably cacheable on Sonnet 5.5 / Opus 5.5 — to be confirmed by the
small real verification, not assumed. T1 keeps its deliberately small routine-task context: prompts are never padded
to cross a cache threshold. T1 max output is seeded at 2,000 (routine chores); T2/T3 at 8,000.

**T1 lifecycle (FleetAdmin 2026-09-30):** keep `claude-haiku-4-5-20251001` while it remains available and verified.
T1 means cheap routine cognition, not "Haiku 4.5". A missing, retired, unavailable or unverified T1 mapping **fails
closed** (`FLEET_COGNITION_TIER_UNAVAILABLE` / `_UNVERIFIED`): T1 work is never silently promoted to T2/T3. A
replacement is installed only through `cognition-tier-set` + `cognition-tier-verify` + `cognition-tier-enable`.
