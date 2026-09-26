# Pre-Genesis cognition hardening (L1–L8, L14; schema v15)

Status: **DEPLOYED 2026-09-26** (runtime `740f083`, build `d7684665…0504`, schema v15); production rehearsal 25/25. Record: runbook Stage H.

A compact launch-hardening pass on the F.2/F.3 real-provider path. It fixes the defects found in the
model/cognition configuration review and adds the provider compatibility probe. It adds no new authority.

## Resolutions

| # | Defect | Resolution |
|---|---|---|
| L1 | A provider HTTP error (e.g. 429) was recorded with code `PROVIDER_HTTP_429`. That violated the log's `[A-Z_]` constraint, rolled the record back and left the founder BUSY for 5 minutes; the founder got a 500 | Errors are classified into letter-only codes (`PROVIDER_RATE_LIMITED`, `_UNAVAILABLE`, `_AUTH_FAILED`, `_MODEL_NOT_FOUND`, `_BAD_REQUEST`, `_HTTP_ERROR`, `_TIMEOUT`, `_UNREACHABLE`, `_CONNECTION_LOST`, `_REDIRECT_REFUSED`, `_MALFORMED_RESPONSE`, `_ERROR`). `svc_cognition_record` (v15) also stores any other code as `PROVIDER_ERROR` instead of failing. Every authorization ends in exactly one record. The founder gets 429 `FLEET_COGNITION_PROVIDER_RATE_LIMITED` (with `Retry-After`), 504 `…_TIMEOUT`, 502 `…_MALFORMED` or 502 `…_PROVIDER_ERROR`; its mind rests 60 s after a rate limit. **Bounded retries:** up to 3 attempts, only for failures the provider did not process (429/500/502/503/504, and connection failures before sending); backoff honours `Retry-After` and is never scheduled past the deadline |
| L2 | The founder gave up at 15 s while the controller waited 60 s, so a slow reply was charged but lost | One controller deadline covers all attempts: `FLEET_COGNITION_DEADLINE_MS` (default 120 s, max 240 s, below the 5-minute in-flight window). Per-attempt timeout: `FLEET_COGNITION_ATTEMPT_TIMEOUT_MS` (default 90 s). Cognition status advertises `deadlineMs` and `founderWaitMs` (deadline + 30 s); the founder's `infer` waits exactly that. **Timeouts and connection losses after sending are never retried** (the provider may have billed) |
| L3 | `max_tokens` was hard-coded; some models require `max_completion_tokens` | `FLEET_COGNITION_MAX_TOKENS_PARAM = max_tokens \| max_completion_tokens` (validated); only the configured field is sent |
| L4 | A response without `usage` was charged 0 | v15 charge rule (below): missing or invalid usage is charged the authorized estimate. An `ok` record can never be uncharged (constraint `ok_is_charged`) |
| L6 | The registry model and the controller's `FLEET_COGNITION_MODEL` were not compared | 409 `FLEET_COGNITION_MODEL_MISMATCH` before authorization (nothing reserved, nothing sent). The provider's reported model (often a dated alias) is logged as `response_model` |
| L7 | Provider requests followed redirects | `redirect: "manual"`; any 3xx is `PROVIDER_REDIRECT_REFUSED` (0 charged), so the key never follows a redirect |
| L8 | Credential isolation relied on file permissions only | Key file checks: absolute path; regular file, not a symlink; 0600; owned by the service's own uid; one line of 8–512 printable characters. The content is never echoed. `InaccessiblePaths=-/etc/automaton-fleet/cognition.key` is added to the founder, operator API, custody, witness, ChatGPT adapter and tunnel units (`automaton-agent` already hides all of `/etc/automaton-fleet`); it is also in `FOUNDER_UNREADABLE_PATHS`. Controller `LimitCORE=0`. `fleet-verify-deployment.sh` checks all of this, and when a key exists: mode/owner, and that no other service user can read it |

Also: tool-call arguments that are not a JSON object, invalid tool names, non-string content, more than 10 calls,
or a non-JSON body now **fail closed**. The whole response is refused and none of its tool calls reach the
founder (earlier, unparseable arguments became `{}`).

## v15 charge rule

The rule is keyed on `usage_source`, which the controller chooses from what it knows about the provider call.
The provider code classifies each outcome.

| Outcome | usage_source | Charge |
|---|---|---|
| Success with valid usage | `provider` | min(estimate, ceil(tokens × price)) |
| Success without usage | `estimate` | the authorized estimate |
| Timeout / connection lost after sending / unexpected error (ambiguous) | `estimate` | the authorized estimate |
| 200 but unusable (malformed), usage present / absent | `provider` / `estimate` | reported usage / estimate |
| Provider error status, redirect, never reached | `none` | 0 |

At most one record per authorization:
- the in-flight row is consumed;
- `request_id` is UNIQUE;
- a replay returns `FLEET_COGNITION_ALREADY_RECORDED`;
- the ledger idempotency key is `infer:<requestId>`.

Retries live inside one authorization, so they can never add a charge. The log gains `usage_source`, `attempts`,
`provider_status`, `response_model` and `latency_ms`.

## L14 provider probe

`sudo scripts/fleet-cognition-probe.sh [--prices <in>,<out>]` on the controller host. It reads **only** the
`FLEET_COGNITION_*` lines of `service.env`, and runs the installed release's `dist/fleet/cognition/probe-main.js`
as `automaton-fleet-service` (the only user that can read the key) under `env -i`, with **no database URL**
(it refuses if one is present).

| Check | What it proves |
|---|---|
| P1 | Authentication, model access, a normal completion, and that the configured output-limit field is accepted (with a hint to switch it on a bad request) |
| P2 | Tool calling with correctly parsed JSON arguments (probe-only `probe_echo` tool) |
| P3 | The real founder toolbox (15 schemas) and charter are accepted. Returned calls are inspected against the manifest, **never executed** |
| P4 | Usage/token accounting returned (WARN if absent: the gateway would charge the estimate) |
| P5 | An unknown model is a classified, uncharged error |
| P6 | A 1 ms timeout is a classified `PROVIDER_TIMEOUT` |
| P7 | Latency within the attempt timeout |

Authority: none. There is no founder, no Genesis, no database and no ledger, and nothing is executed. The output
contains only codes, statuses, token counts, validated names and timings. It never contains the key (also
scrubbed from the output as a last line of defence) or provider bodies and model text. Exit codes: 0 PASS,
1 FAIL, 2 not configured / refused. Cost: 3 small billable calls
(P1–P3); the unknown-model (P5) and 1 ms (P6) calls are refused or aborted before any generation.

## Rehearsal

The real-runtime rehearsal's controller now reaches its model through the **real OpenAI-compatible provider
over HTTP**, against a loopback fake provider (fake key, scripted model). Founder 1 gets injected faults:
- 429 then success on retry;
- 503 until retries are exhausted;
- malformed JSON;
- a timeout;
- unparseable tool arguments;
- a response without usage;
- a redirect.

New checks:
- each fault is classified, recorded once and charged by rule;
- founder 1 keeps thinking afterwards;
- every provider attempt equals the records' attempts, and every charge has exactly one journal;
- nothing is left in flight;
- founder 2 is unaffected (all calls ok on the first attempt).
