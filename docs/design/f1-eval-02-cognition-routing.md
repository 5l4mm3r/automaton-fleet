# F1-EVAL-02 — Model routing and cognition economics (evaluation)

Status: **EVALUATION ONLY. Nothing implemented or deployed.** Written 2026-09-28 against `c83b434`
(controller `0c502fb`, schema v21; Founder 1 `01M3F50SH7PNX2E3GST13J52AS` pinned to `eea1932`).

Question: can the Fleet route Founder cognition across capability tiers and providers while Founder identity,
economic state, knowledge and memory stay independent of the model? How strongly is the Founder coupled to Anthropic
today? What is the smallest clean path to tiered routing and to a controlled OpenAI-vs-Anthropic benchmark?

Short answer:
- **Founder identity is not coupled to Anthropic.** The coupling that exists is in cognition continuity and in the
  controller's single-model design.
- **No routing exists.** The controller runs exactly one provider/model with one reasoning configuration.
- **Continuity today is transcript replay.** The mind sends its last 16 messages on every call, and those messages
  carry Anthropic-signed thinking.
- **The provider interface can take tiers and a second provider without a refactor.** It needs about five additive
  changes (§7), and none of them has to touch Founder 1.

## 1. Current live configuration (the control baseline)

Taken from runbook Stages A, G1 and CL. The owner's `cognition-enable` sets it, and `service.env` holds it.

| Item | Value |
|---|---|
| Provider / model | `anthropic` / `claude-opus-5-5` (native Messages API, `anthropic-version` 2023-06-01) |
| Reasoning | `FLEET_COGNITION_THINKING=adaptive`, `FLEET_COGNITION_EFFORT=medium` (process-wide) |
| Output limit | 4,000 tokens |
| Prices (USD µ¢/token) | in 400 / out 2000 / cache-write 500 / cache-read 20 |
| Limits | 20 calls/h; 754p/day (≈ $10 at 0.754583) |
| Charter / manifest | `founder-charter-v2` / founder-v2 |
| Founder history | last 16 messages, ≤ 40 KB request, ≤ 4 steps/turn, thinking every 2nd heartbeat |

## 2. Coupling assessment

### 2.1 Provider-neutral (no Anthropic coupling)

| Layer | Evidence |
|---|---|
| Founder identity | ULID, `founder.json` (workspace/state namespace, manifest digest), registry row, runtime pin, credential. None of them names a provider or model (`founder/runtime.ts:351-456`). |
| Economic state | The GBP ledger, spend orders, protected capital and FX all live in PostgreSQL. Inference is just an `inference_charge` journal. The ledger never records which model did the thinking. |
| Credential isolation | Founders never hold a provider key. Preflight refuses any `FLEET_COGNITION_*` or `*_API_KEY` in a founder environment (`runtime.ts:372`), and the key file is on the founder-unreadable list. |
| Provider contract | `CognitionProvider.chat(ChatRequest) → ChatResult` with canonical `ChatMessage`, `Usage` (in/out/cache read/cache write/thinking) and the `ProviderError` taxonomy with a charge class (`cognition/types.ts:36-127`). |
| HTTP core | `postWithRetries` handles deadline, retries, redirect refusal and bounded error bodies for both HTTP adapters (`providers.ts:432`). |
| Accounting | `costMicrocents` / `chargedMicrocents` / `accrue` take any `Usage` and `Prices` (`charging.ts`). USD cost becomes a GBP charge in `svc_cognition_record` (v21). |
| Charter and tools | Compiled, provider-neutral text plus JSON Schema. Each adapter maps them itself. |
| Persistent memory | `facts.json`, `goals.json` and workspace notes (founder-private), plus knowledge, research attempts and the ledger (controller DB). All plain data with no model state in it. |
| Second provider | `OpenAICompatibleProvider` already exists: L1–L8 hardened, parses `reasoning_tokens` and cached tokens, L14 probe path, fake server (`fake-openai.ts`). |

### 2.2 Coupled, or structurally single-model

| # | Coupling | Where | Effect on routing |
|---|---|---|---|
| C1 | **Provider-bound state in the canonical transcript.** `ThinkingBlock` and `blockOrder` sit in `ChatMessage`, are persisted in the founder's `mind-history.json` and are handed back through the gateway. | `types.ts:24-47`, `mind.ts:151-157`, `gateway.ts:388-389` | Replaying them to a different model or provider is invalid. Blocks carry no producer tag, so the gateway cannot tell whose they are. The only safety today is `atNewTurnDropThinking`, which is Anthropic-internal (`anthropic.ts:205`). |
| C2 | **One provider and one model per controller.** `loadCognitionProvider` builds a single instance from env, and the gateway refuses unless the registry's provider/model equals the process's (`FLEET_COGNITION_MODEL_MISMATCH`). | `service/main.ts:217-251`, `gateway.ts:465-467` | No per-call model selection is possible. |
| C3 | **One policy row.** `fleet_cognition_policy` (id = 1) holds one provider, one model and one price set. | v13/v16/v21 | No tiers, no per-tier prices, no per-tier budgets. |
| C4 | **Reasoning config is process-wide and Anthropic-only.** Thinking and effort live in `AnthropicOptions`. The loader refuses them for `openai_compatible` (`main.ts:244`). `ChatRequest` has no per-call reasoning field. | `anthropic.ts:39-47, 293-296` | Effort cannot vary by task, and OpenAI reasoning effort cannot be expressed. |
| C5 | **Continuity = transcript replay, built by the founder.** Every call re-sends up to 16 messages (≈ 5–7k tokens at turn openings, Stage CL). Persistent memory reaches the model only when the model chooses to call `recall_facts` / `list_goals` / `read_file`. | `mind.ts:38, 62-70, 131-137` | A model switch must either replay the transcript (forbidden by the task) or rely on the new model to go and recall state (neither deterministic nor measurable). |
| C6 | **The cognition log records no routing facts.** It has provider, model, tokens, cache, USD cost, GBP charge, FX, attempts, latency, stop reason and prompt digest. It lacks task class, tier, effort/thinking config, escalation, reason, parent call and packet/retrieval token counts. | v13/v15/v16/v21 | The economics record required by §6 cannot be produced from existing rows. |
| C7 | **The provider id is a closed union with a DB CHECK.** | `types.ts:92`, v16 constraint | Intentional: a new provider needs a reviewed migration. Not a defect. |

### 2.3 Verdict

Founder 1's identity, capital, permissions and institutional knowledge would survive a provider change with no
migration. What would **not** survive cleanly is its working conversation: C1 and C5 make the transcript partly
Anthropic-bound. C2–C4 and C6 make routing impossible today, but they sit entirely on the controller side.

### 2.4 Hard constraint: Founder 1 is pinned

Founder 1 runs `eea1932` and **must not move** (runbook, "Live runtime updates with living founders"). Its
`mind.ts` is behaviourally the same as HEAD for this purpose: 16-message replay, thinking carried on the latest
assistant message. The consequences:
- Anything the **controller** does can reach Founder 1: tier selection, thinking hygiene, logging.
- Anything that changes **what the founder sends** cannot reach Founder 1. That includes task packets, escalation
  requests and structured retrieval. Those need a new founder runtime, which means a new founder or a
  founder-runtime migration procedure that does not exist yet.
- The controller **cannot build task packets from founder memory**. `facts.json`, `goals.json` and workspace notes
  are founder-private by design (0700 state namespace), and the controller sees only what the founder sends. This
  privilege separation should stay.

## 3. Target architecture

```
Economic task (founder step)
  → founder: task class + optional escalation request {reasonCode, parentRequestId}   (a request, never a choice)
  → FleetController cognition classifier:
        tier = clamp( max(minTier(class), approvedEscalation), maxTier(class), policy/budget/rate/availability )
  → tier → candidate (provider, model, reasoning config)            (owner-set policy table; tiers ≠ brands)
  → provider.chat(task packet or in-loop continuation)
  → observable result (content + tool calls; never private reasoning across a handoff)
  → svc_cognition_record: charge + immutable economics row
  → evaluator/owner-only outcome scoring → future routing weights
```

### 3.1 Tiers are capability requirements, not model names

| Tier | Capability required | Initial Anthropic candidate (to verify, §5) |
|---|---|---|
| T1 routine | Extraction, classification, triage, dedup, summarisation of provided text | `claude-sonnet-5`, effort `low` |
| T2 analytical | Synthesis, hypothesis formation, competitor comparison, validation planning, evidence reconciliation | `claude-opus-5-5`, adaptive thinking, effort `medium`/`high` |
| T3 critical | Capital allocation, major strategy change, conflicting high-quality evidence, irreversible or survival-relevant decisions, reproduction recommendations, lower-tier insufficient confidence | `claude-fable-5-1`, highest supported effort |

The mapping lives in a policy table (§7 R2) that only the owner can change. The code knows tiers and task classes,
never brands.

### 3.2 Routing authority (FleetController, not the founder)

- **Minimum tiers are deterministic.** A compiled `task class → minTier` table. For example, `capital_allocation`,
  `strategy_change` and `reproduction_recommendation` → T3; `opportunity_analysis` and `evidence_reconciliation` → T2;
  `extraction` and `triage` → T1.
- **Mislabelling is caught at the point of consequence, not by trusting the label.** The cognition log already stores
  each call's requested tool calls with argument digests (`toolCalls[].argsSha256`). The controller can refuse a
  consequential action whose producing cognition call ran below that action's minimum tier: for example
  `request_spend` above a threshold, `propose_knowledge` of category `policy`, or any future reproduction request.
  An under-declared class saves the founder nothing, because the resulting action is refused.
- **Escalation is a request with a closed reason code:** `uncertainty`, `conflicting_evidence`,
  `financial_consequence`, `irreversibility`, `repeated_lower_tier_failure`, `insufficient_confidence`, `novelty`,
  `complex_synthesis`. Token volume is **not** a reason code. The controller approves an escalation against per-tier
  daily count and budget caps, and against eligibility rules. For example, `repeated_lower_tier_failure` needs ≥ 2
  failed lower-tier rows in the same task.
- **No budget-driven downgrade below minTier.** If the budget cannot cover the required tier, the call is refused
  (`FLEET_COGNITION_BUDGET_EXHAUSTED`), never quietly run on a cheaper model. A downgrade is allowed only above minTier
  (for example, T3 unavailable → T2 when class minTier is T2), and it is recorded.
- **Availability fallback** goes only to another candidate of the **same tier**. When there is none, the call fails
  (classified, uncharged), never falls to a lower tier.

### 3.3 Context economics and handoff

**Rule 1: a switch happens only at a turn boundary.** Within a tool loop (the last user turn holds only tool
results), the provider, model and reasoning config stay fixed, and provider-bound continuation is handed back
verbatim. This is the existing Stage CL safe behaviour, unchanged. A mid-loop escalation first closes the loop:
- the escalating step returns an observable result;
- the next call starts a new conversation from a task packet.

**Rule 2: foreign provider state is never sent.** Tag every `ThinkingBlock` with its producer
`{provider, model}`, set by the controller from the call that produced it. Before `provider.chat`, the gateway drops
every block the target model did not produce. This generalises `atNewTurnDropThinking` from an Anthropic rule into a
gateway invariant. A founder-forged tag gains nothing: Anthropic verifies signatures, and other providers never
receive the blocks.

**Rule 3: a handoff sends a task packet, never the transcript.** A provider-neutral JSON object, rendered as the
single first user message:

```jsonc
{
  "packet": "fleet-task-v1",
  "objective": "…open goal(s) from goals.json",
  "task": "…the specific question",
  "taskClass": "evidence_reconciliation",
  "escalation": { "fromTier": "T2", "reasonCode": "conflicting_evidence", "parentRequestId": "…" },
  "knowledge": [ { "key": "…", "value": "…", "source": "facts.json" } ],        // deterministic filter, bounded
  "evidence": [ { "attemptId": "…", "url": "…", "path": "research/…", "sha256": "…", "excerpt": "…" } ],
  "strategy": "…current hypothesis / plan notes (file refs)",
  "previousResult": "…observable output needed to continue (no reasoning)",
  "uncertainty": ["…"],
  "economics": { "cashPence": 0, "protectedPence": 0, "dailyCognitionRemainingPence": 0 },
  "policy": ["no trading/custody authority", "spend only via request_spend", "…"],
  "outputContract": { "form": "decision|analysis|extraction", "mustCite": true }
}
```

- **Construction is deterministic.** Recall filters, open goals, evidence references and the ledger snapshot are
  gathered without calling another model to choose context.
- **Evidence is never summarised away.** The packet carries references plus bounded verbatim excerpts with digests.
  Authoritative sources stay where they are: `research/` files, the controller's research log and the ledger. The
  receiving model can `read_file` the full source.
- **Where it must be built:** in the founder runtime (§2.4), since founder memory is private. The controller
  validates packet shape and size, rejects secret shapes as it does today, and records the packet's token counts.
- **Excluded:** full history, unrelated research, stale tool output, any `ThinkingBlock` and any provider reasoning
  item.

### 3.4 Total cognition cost

For a task (all calls sharing a task id / parent chain):

```
total = Σ model cost (ok rows)
      + Σ context cost        (input + cache-write attributable to packet/history)
      + Σ repeated research   (web_fetch of an already-fetched URL within the task window, + its cognition step)
      + Σ failure/retry cost  (error rows charged 'estimate'/'usage', + ok rows superseded by an escalation)
```

Every term can be derived from the immutable cognition and research logs once the §7 R2 columns exist. The metric
that matters is **cost per successful economic decision**, not per-call price.

## 4. Economics record (per call)

| Required field | Today | Source after R2 |
|---|---|---|
| task class, assigned tier, requested tier | — | controller-computed columns |
| provider, model | ✓ | unchanged |
| effort / thinking config | — (env only) | `reasoning` jsonb, from the candidate row |
| escalation / downgrade, reason, parent | — | `route_change` enum, `route_reason` code, `parent_request_id` |
| packet input tokens, retrieved-knowledge tokens | — | founder-declared section byte counts, controller-verified against the request, stored as estimates |
| input / output / cache read / cache write / thinking | ✓ (thinking not stored) | add `thinking_tokens` |
| native provider cost (USD µ¢), GBP charge, FX | ✓ | unchanged |
| handoff flag | — | `handoff boolean` |
| observable result, success | digest only | `fleet_cognition_outcomes` (R5) |

**Integrity:**
- `fleet_cognition_log` is already immutable (no UPDATE/DELETE/TRUNCATE triggers), and only `svc_cognition_record`
  writes it.
- Outcome and score rows go in a separate append-only table, written only by an owner or evaluator role. No founder
  grant exists, so a founder can never alter its own performance history or routing scores.

## 5. Model and parameter verification (do not assume)

The candidates above are **unverified for fleet use**. Before any candidate is enabled for any tier:
- Run the **L14 probe** (`fleet:probe`, P1–P11) against that exact model with that exact reasoning config. It
  confirms auth, tool use, tool-result continuation, charter plus real toolbox, usage categories, and timeout and
  error classification.
- Record the list prices from the provider's pricing page (as Stage A did for `claude-opus-5-5`).
- Record which reasoning parameters the model accepts. For Anthropic: adaptive thinking, the `output_config.effort`
  values, and whether `max` is supported for that model. For OpenAI: the effort parameter and its values on the
  chosen API surface.
- OpenAI "GPT-6 Sol" / "GPT-6 Astra" are **names to verify**. Model ids, availability, API surface (Chat Completions
  vs Responses), tool-calling behaviour and prices must come from the provider at implementation time.
- The OpenAI key under `/etc/automaton-fleet/chatgpt-tunnel/` belongs to the tunnel and must **not** be reused for
  cognition. A benchmark key is a separate owner-installed credential with its own spend cap.

## 6. F1-EVAL-02 experimental control

### 6.1 Primary memory/learning gauntlet: one fixed configuration

- **Configuration:** the §1 baseline exactly, recorded as a config digest: provider, model, reasoning, max output,
  charter version, manifest digest, controller commit, founder commit.
- **No routing, no tier changes and no provider changes** during the primary gauntlet. Any change starts a new,
  separately labelled trial.
- **Live Founder 1** can only run the **replay arm**, because its runtime is pinned (§2.4).

### 6.2 Context-severance measurement: separate arms, same model

| Arm | Context at each phase boundary |
|---|---|
| A — replay | Current behaviour (16-message history) |
| B — severance + structured retrieval | History cleared. First message = a deterministic task packet built from facts, goals, notes, knowledge and the ledger |
| C — severance only (negative control) | History cleared. Only the plain observation, with no packet |

Metrics per phase:
- goal continuity: the same open goal is pursued or explicitly closed;
- contradiction with recorded facts;
- repeated research: re-fetching a known URL, or re-deriving a recorded fact;
- steps to first productive action;
- input, cache and output tokens per turn;
- GBP cost per turn and per completed goal.

"Coherent continuation" = B ≈ A on continuity and contradiction, with B < A on context tokens. C shows how much the
packet contributes.

**Where it runs.** The primary place is an **offline harness** extending `cognition/context-repro.ts`. That harness
already drives the real `FounderMind`, the real toolbox (throwaway workspace), the real provider adapter and the
production charter. It needs no founder, registry or ledger, and `web_fetch` is canned, so it is reproducible. Arms
A, B and C run on the same scripted phase sequence, and each arm runs ≥ 3 times, since the model is stochastic.

Spend is paid from the provider balance outside fleet metering, as with the Stage CL diagnostics. It must be
pre-approved and recorded as an owner adjustment.

An optional live severance of Founder 1 means clearing its `mind-history.json`. That is an owner action on
production founder state, so it needs **explicit approval**. The mind already survives an empty history, since it
resets on `PROVIDER_REJECTED`, but only arm C can run live. Arm B cannot run live because of the pin.

### 6.3 Tier and provider comparison trials: isolated

- Every arm receives **identical task packets**, with identical canned evidence and tool access.
- Each arm is one fixed candidate: T1-Sonnet, T2-Opus, T3-Fable, later OpenAI-Sol and OpenAI-Astra.
- Metrics:
  - task success on objective checks;
  - decision quality, scored blind by the owner/evaluator;
  - evidence use and citation of attemptIds;
  - correction after planted contradictory evidence;
  - transfer on a second, related task;
  - unnecessary tool calls;
  - latency;
  - token usage by category;
  - provider cost;
  - cost per successful decision.
- Results feed `fleet_cognition_outcomes` as evaluator rows. They never feed the founder's own records.

## 7. Smallest implementation plan

Each step is separately reviewable and ships with targeted tests. A step marked ✱ needs operator approval to deploy.
The order keeps Founder 1 untouched: every live change is controller-side, and the defaults reproduce today's
behaviour.

| Step | Change | Size | Schema | Reaches Founder 1 |
|---|---|---|---|---|
| **R0** | Producer tag on `ThinkingBlock` (set by the gateway from `provider.id` / `provider.model`), and the gateway drops foreign-producer blocks before `chat`. `ChatRequest.reasoning?: {effort?, thinking?}` per call. Each adapter maps it or refuses it with `PROVIDER_CONFIG_INVALID` (uncharged). The Anthropic process-wide env becomes the default. | S | none | yes (a no-op while one model is configured) |
| **R1** | Controller provider registry: `Map<candidateId, CognitionProvider>` built from env blocks (one key file per provider). Each candidate is probed at startup. The gateway picks by tier instead of asserting a single `status.model`. | S–M | none | yes (a single candidate = today) |
| **R2** ✱ | Schema v22. `fleet_cognition_tiers` (tier, candidate id, provider, model, reasoning jsonb, prices, max output, enabled), owner CLI `cognition-tier-set`. Compiled `task class → min/max tier`. Per-tier daily caps. `fleet_cognition_log` columns from §4. `svc_cognition_authorize` takes the effective tier; `svc_cognition_record` writes routing columns. Default: T1 = T2 = T3 = the current Opus candidate. | M | v22 migration ✱ | yes (behaviour identical by default) |
| **R3** | Founder runtime: task class and escalation request in `/v1/cognition/infer`, a deterministic packet builder, and a turn-boundary handoff. | M | none | **no** (new founders only) |
| **R4** | Offline eval harness: arms A/B/C (§6.2) and the packet corpus for tier/provider trials (§6.3). | S–M | none | no |
| **R5** ✱ | `fleet_cognition_outcomes` (append-only, evaluator/owner role only) and the consequence-point tier check for `request_spend` above a threshold. | M | v23 ✱ | the consequence check applies to all founders |
| **R6** ✱ | OpenAI candidate: owner key, `reasoning` mapping in `OpenAICompatibleProvider` (the parameter verified per §5), L14 probe, R4 trials. Enabled for live founders only on benchmark evidence. | S | none | only when the owner maps a tier to it |

- **Not needed:** a provider-interface rewrite, a new adapter for Anthropic, or any change to identity, ledger or
  custody.
- **OpenAI:** if the chosen models require the Responses API rather than Chat Completions, R6 grows to a small new
  adapter on the same `postWithRetries` core, with the same producer-tag rule for any encrypted reasoning items. That
  is still no refactor.
- **During F1-EVAL-02:** R0 and R4 are the only steps needed to run §6.2 offline. R0–R2 can deploy with every tier on
  the baseline candidate, so the primary gauntlet stays uncontaminated.

## 8. Decisions for the operator

1. **Memory locus.** Keep founder memory private and build packets founder-side (recommended; preserves privilege
   separation), or move facts/goals into controller-mediated storage (larger, and lets the controller build packets).
2. **T3 authority.** Automatic under policy caps, or T3 decisions above a capital threshold also require owner
   confirmation.
3. **Live severance on Founder 1** (arm C only). Allowed or not.
4. **Benchmark spend and an OpenAI benchmark key:** amount, cap and accounting (owner adjustment as in Stage CL).
5. **Initial minTier table and thresholds**, for example the pence threshold above which `request_spend` needs a T3
   producing call. This is economic policy and needs review.
