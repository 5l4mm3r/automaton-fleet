# Pre-Genesis step 2.1 — Native Anthropic cognition adapter (schema v16)

Status: **DEPLOYED 2026-09-26** (runtime `6ed4a28`, build `0af8aa77…bfee`, schema v16); production rehearsal 26/26. Record: runbook Stage A.

Owner decision (step 2): tier A (maximum capability), Anthropic Claude, **native Messages API** (M2), one shared
fleet credential with fully independent founder cognition. Initial targets, not yet applied:
- max output 4,000 tokens;
- 20 model calls/hour per founder;
- thinking every 2 heartbeats;
- about $10/day per founder, subject to verified pricing.

The exact model ID, prices and the provider-side monthly cap are **not locked**, and none is assumed here.

## 1. Provider architecture

```
CognitionProvider (id, model, chat(ChatRequest) → ChatResult | throws ProviderError)
├── scripted            tests / rehearsal model (no network)
├── openai_compatible   OpenAI Chat Completions protocol (L1–L8 hardened)
└── anthropic           NATIVE Messages API (this step)
        both HTTP providers share postWithRetries(): one deadline, per-attempt timeout, retries only for
        unprocessed failures (429/500/502/503/504/529, connect errors) honouring Retry-After, timeouts and
        post-send connection loss never retried (estimate charged), redirects refused, bodies never logged
```

The generic interface stays provider-neutral. Anthropic-specific settings live in `AnthropicOptions` only.

## 2. Protocol mapping (`src/fleet/cognition/anthropic.ts`)

| Fleet (canonical) | Anthropic |
|---|---|
| controller charter | `system` (string) |
| `user` message | user turn, text block |
| `assistant` message | assistant turn: signed thinking blocks, text and `tool_use` blocks **in the original order** (a recorded `blockOrder`) |
| `tool` messages (1..n) | ONE user turn of `tool_result` blocks (`tool_use_id`, `content`, `is_error` for refusals/not-executed), **results first**; a following observation is appended to the same turn as text (strict alternation) |
| founder toolbox | `tools` (`name`, `description`, `input_schema`) |
| policy `max_output_tokens` | `max_tokens` (the only output-limit field; `max_completion_tokens` is refused for this provider) |
| headers | `x-api-key`, `anthropic-version` (default `2023-06-01`), optional `anthropic-beta` |
| endpoint | `POST {base}/messages`, base default `https://api.anthropic.com/v1` |

**Response parsing fails closed.** The whole response is refused, nothing reaches the founder, and any usage it
carried is still charged, on:
- a non-message body;
- an unknown block type (no server tools are ever enabled);
- `tool_use` blocks unless `stop_reason` is `tool_use` (a `max_tokens` stop may have truncated them);
- a `tool_use` stop without calls;
- an invalid tool name, id or input (not an object);
- more than 10 calls;
- an unknown `stop_reason`;
- thinking without a signature/data.

Recorded stop reasons: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `pause_turn`, `refusal`,
`model_context_window_exceeded`.

**Errors.** Codes are classified; bodies are never logged.

| Status | Code | Retry |
|---|---|---|
| 400 / 413 | `PROVIDER_BAD_REQUEST` (founder sees `FLEET_COGNITION_PROVIDER_REJECTED`, and its conversation resets so it cannot stay wedged) | no |
| 401 / 403 | `PROVIDER_AUTH_FAILED` | no |
| 402 | `PROVIDER_BILLING` | no |
| 404 | `PROVIDER_MODEL_NOT_FOUND` | no |
| 429 | `PROVIDER_RATE_LIMITED` | yes |
| 500 / 529 | `PROVIDER_UNAVAILABLE` | yes |

The provider's `request-id` header or message `id` is recorded.

## 3. Tool calls (bounded, never silent)

- At most **10** calls per response. More is malformed: fail closed.
- At most **5** are executed per step. Calls 6–10 each get an explicit
  `NOT EXECUTED FLEET_TOOL_CALL_LIMIT` tool result with `is_error`.
- Every `tool_use` is answered (the protocol requires it), so nothing is dropped silently.
- Execution is unchanged: capability manifest → implemented → per-tool guards (workspace, shell guard, Landlock)
  → FleetController/database policy. Model output has no authority of its own.

## 4. Reasoning / thinking configuration surface

Controller-only environment, **unset by default** (nothing is sent; the model's own default applies):

| Setting | Values | Sends |
|---|---|---|
| `FLEET_COGNITION_THINKING` | `adaptive` | `thinking: {type: "adaptive"}` (current docs: Opus 5.5 / Sonnet 5) |
| | `enabled:<N>` (N ≥ 1024) | `thinking: {type: "enabled", budget_tokens: N}` (current docs: Haiku 4.5) |
| `FLEET_COGNITION_EFFORT` | `low` / `medium` / `high` / `max` | `output_config: {effort}` |
| `FLEET_COGNITION_ANTHROPIC_BETA` | feature names | `anthropic-beta` header |
| `FLEET_COGNITION_ANTHROPIC_VERSION` | date | `anthropic-version` (default `2023-06-01`) |

- A budget that does not fit the policy's `max_output_tokens` is refused **locally** (`PROVIDER_CONFIG_INVALID`,
  nothing sent, nothing charged).
- These settings are refused for any other provider.
- **Production value: unset**, pending the final model selection. The L14 probe reports the effective settings.

**Signed thinking continuity.** Thinking and redacted-thinking blocks are opaque: only `type`, `thinking`,
`signature` and `data` strings are kept.
- They are returned to **their own founder only**, stored in its private history on the **latest assistant
  message only**, and handed back unchanged and in order. Argument compaction and text truncation are
  skipped for that message.
- The gateway re-validates them (shape, ≤ 8 blocks, ≤ 32k characters, no credential-shaped text).
- The provider verifies the signature, so a founder cannot forge reasoning. A tampered block is rejected by
  the provider, charged 0, and the founder's conversation resets.
- Thinking text is never written to the controller's log.

## 5. Accounting mapping (schema v16)

| Anthropic usage | Canonical | Charged at |
|---|---|---|
| `input_tokens` (excludes cache) | `inputTokens` | input price |
| `output_tokens` (includes thinking) | `outputTokens` | output price |
| `cache_creation_input_tokens` | `cacheWriteTokens` | cache-write price, **else the output price** (conservative) |
| `cache_read_input_tokens` | `cacheReadTokens` | cache-read price, else the input price (conservative) |
| `output_tokens_details.thinking_tokens` (if present) | `thinkingTokens` | informational (already in output) |

- The OpenAI-compatible route now reports `prompt_tokens_details.cached_tokens` as cache reads (canonical input
  excludes them) and `reasoning_tokens` as thinking.
- Everything else is unchanged from v13/v15:
  - pre-call reservation;
  - the daily budget, calls/hour and prepaid-credit gates;
  - charge = min(estimate, ceil(cost)) for provider usage;
  - the estimate is charged for missing usage or an ambiguous timeout;
  - 0 is charged for provider error statuses;
  - one record per authorization (replay → `ALREADY_RECORDED`) and ledger idempotency `infer:<requestId>`.
- New log columns: `cache_read_tokens`, `cache_write_tokens`, `provider_request_id`, `stop_reason`.
- New policy fields: `cache_write_microcents_per_token`, `cache_read_microcents_per_token`
  (`cognition-enable … --cache-write-microcents N --cache-read-microcents N`).
- `src/fleet/cognition/charging.ts` mirrors the SQL rule; tests cross-check it against the database.
- **Invoice reconciliation:** per call, the log holds the provider's message/request id, tokens by category,
  raw cost and charge.

## 6. Credential isolation

Unchanged L8 architecture: one key file (`/etc/automaton-fleet/cognition.key`, 0600, owned by the controller's
user, validated, never echoed). It is sent only as `x-api-key` to the configured HTTPS endpoint (redirects
refused). It is in `InaccessiblePaths` of every other unit and in the founder unreadable list, the controller
has `LimitCORE=0`, and it is absent from the log, audit, database and process arguments.

## 7. L14 for Anthropic

`sudo scripts/fleet-cognition-probe.sh [--prices in,out[,cacheWrite,cacheRead]]` uses the controller's own loader,
so it applies the same key-file checks and the same thinking/effort settings.

| Check | What it proves |
|---|---|
| P1 | Authentication, model, completion |
| P2 | Native `tool_use` with parsed input |
| P3 | `tool_result` continuation (incl. signed thinking) |
| P4 | Founder toolbox + charter accepted (calls inspected, not executed) |
| P5 | Forbidden-tool containment (an injected "call transfer_credits" is refused by the manifest if attempted) |
| P6 | Usage by category |
| P7 | Economic reconciliation (the ledger's charge for each call) |
| P8 | Malformed-response containment (canned bad Messages responses refused by the deployed parser) |
| P9 | Unknown model: a classified, uncharged error |
| P10 | 1 ms timeout |
| P11 | Latency |

No founder, no database, no authority; the key is never printed.

## 8. Rehearsal

The real-runtime rehearsal's controller now uses the **native Anthropic adapter** against a loopback fake Messages
API. The fake enforces:
- alternation;
- tool results first and complete;
- `max_tokens`;
- headers;
- **signed-thinking continuity** (thinking is enabled in the fake).

Founder 1's provider faults (429→retry, 503×3, malformed, timeout, bad tool input, no usage, redirect) run
through the native path. A new check requires **zero protocol violations** across the real founder loops.

## 9. Sub-cent inference accounting (L13, schema v17)

Until v16 every call was rounded **up** to a whole cent. On the real L14 probe, $0.0367 of provider cost would
have been charged 7¢. v17 keeps the ledger in integer cents and gives each founder an exact integer microcent
accrual (`fleet_cognition_accrual.unposted_microcents`, 0 ≤ r < 10⁶; no floating point):

- `charged_µ¢` for a call (logged as `charged_microcents`) = min(reservation·10⁶, provider cost) for provider usage;
  the reservation for an ambiguous outcome; 0 for a provider error.
- `total = unposted + charged_µ¢` → post `floor(total / 10⁶)` whole cents in one idempotent journal
  (`infer:<requestId>`, only if > 0) → carry `total − posted·10⁶`.
- **Exact invariant per founder:** Σ posted·10⁶ + unposted = Σ charged_µ¢. The ledger never exceeds the true
  cost and lags it by < 1¢. The remainder is carried, never forgiven and never rounded up.
- **Gates are exact and fail closed in µ¢, counting the unposted remainder as spent:**
  - daily budget: Σ charged_µ¢ (24 h) + reservation·10⁶ ≤ budget·10⁶;
  - own cash and survival equity: value·10⁶ − unposted ≥ reservation·10⁶;
  - prepaid credits: balance·10⁶ − Σ unposted ≥ reservation·10⁶.
- The accrual cannot be deleted or truncated, and only `svc_cognition_record` writes it (cognition surface audit).
- Pre-v17 log rows keep `charged_microcents` NULL and are read as `charged_cents·10⁶`: history is not rewritten.
- Real L14 under v17: 3,670,000 µ¢ → **3¢ posted + 670,000 µ¢ carried** (v16 would have posted 7¢).
- Residual: a founder that stops forever leaves < 1¢ recorded but unposted in its accrual row (visible, never
  lost). Estate settlement does not yet sweep it.
