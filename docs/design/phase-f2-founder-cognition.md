# Phase F.2 — Founder cognition through FleetController (schema v13)

Status: **DEPLOYED 2026-09-25** (runtime `c7c2a05`, build `459539f5…c4f9`, schema v13); production rehearsal 20/20. Production cognition **DISABLED** (provider `none`). Deployment record: `docs/fleet-production-runbook.md` (Stage F.2).
Genesis stays **disabled**, production population **0**. No real inference credential exists. Egress stays
**closed** (founder units are loopback-only). The owner's go-live steps are in `docs/genesis-launch-checklist.md`.

## 1. What F.2 adds

A founder can now *think*: observe, decide and act in a loop. It reaches a model **only through
FleetController**. The model never receives a key, a budget or a tool the founder was not granted.

```
founder runtime (DynamicUser, loopback only)                FleetController (127.0.0.1)                 provider
 FounderMind ─ turn per heartbeat                              POST /v1/cognition/infer
   status? ──GET /v1/cognition/status──▶ owner switches        1 validate: no system role, bounded,
   history + observation ──────────────▶                          no credential-shaped text
                                                               2 tools = FOUNDER_TOOLS ∩ manifest
                                                               3 svc_cognition_authorize (DB)
                                                               4 provider.chat  ─────────────────────▶ scripted (rehearsal)
                                                               5 svc_cognition_record (DB):               openai_compatible (owner key,
   ◀── content + tool calls ────────────                          charge ledger, append log                not configured)
 FounderToolbox executes each call:
   manifest → implemented? → per-tool guard → (fleet tools) controller + DB again
   results fed back as UNTRUSTED data
```

| Piece | File |
|---|---|
| Schema v13 (policy, per-founder switches, in-flight lock, trusted log, `inference_charge` ledger kind) | `src/fleet/postgres/migrations-phase13.ts` |
| Gateway | `src/fleet/cognition/gateway.ts`, routes in `src/fleet/service/server.ts` |
| Charter and tool catalogue (compiled; the founder cannot edit them) | `src/fleet/cognition/types.ts` |
| Providers: `ScriptedProvider` (deterministic, credential-free), `OpenAICompatibleProvider` | `src/fleet/cognition/providers.ts` |
| Controller provider configuration (`FLEET_COGNITION_PROVIDER`, default `none`) | `loadCognitionProvider` in `src/fleet/service/main.ts` |
| Founder mind and toolbox | `src/fleet/founder/mind.ts`, `src/fleet/founder/toolbox.ts`; started by `runFounderRuntime` when `FLEET_FOUNDER_AGENT_LOOP=controller` (the shipped unit) |
| Egress policy and CONNECT proxy (built, **not deployed**) | `src/fleet/cognition/egress.ts` |
| Owner CLI | `pnpm fleet:admin cognition-policy / cognition-enable / cognition-disable / founder-cognition / cognition-status / cognition-log` |
| Rehearsal (cognition phase) | `src/fleet/founder/rehearsal.ts` |

## 2. Controls (who can stop a founder thinking, and how fast)

Every inference is re-authorized in the database (`svc_cognition_authorize`), so each switch below
takes effect on the next call. There is no cache.

| Control | Owner | Effect |
|---|---|---|
| `cognition-disable` (global) | owner CLI → `fleet_cognition_set_policy` | Every founder: `FLEET_COGNITION_DISABLED` |
| `founder-cognition <id> pause` (kill switch) | owner CLI → `fleet_founder_cognition_set` | That founder: `FLEET_COGNITION_PAUSED`; the others continue |
| per-founder enable (default **off**) | owner CLI | `FLEET_COGNITION_FOUNDER_DISABLED` |
| inference calls/hour (default 30) | owner CLI | `FLEET_COGNITION_RATE_LIMITED` |
| daily budget (default 100¢) | owner CLI | `FLEET_COGNITION_BUDGET_EXHAUSTED` (the estimate is reserved up front; the charge never exceeds it) |
| one call in flight per founder | database | `FLEET_COGNITION_BUSY` |
| the founder's own cash and survival equity | ledger | `FLEET_INSUFFICIENT_ALLOCATION` / `FLEET_PROTECTED_CAPITAL`: a founder cannot think itself into its protected principal |
| prepaid fleet credits | ledger (`fleet:conway_credits`) | `FLEET_COGNITION_CREDITS_EXHAUSTED` |
| death, quarantine, termination | trigger `fleet_agents_cognition_stop` | disables and pauses cognition, clears in-flight; authentication also fails |
| owner hold | database | `FLEET_AGENT_HELD` |
| registry vs controller provider | gateway | `FLEET_COGNITION_PROVIDER_MISMATCH` (the owner switch and the service configuration must agree) |

The owner functions are never granted to the service, agent, operator or custody roles. They refuse an
actor that is not `operator:<name>`, and `fleet_require_operator_approver` refuses AI principals.

## 3. Economics

- An inference is an **expense of the founder that thinks**. Kind `inference_charge` (source `controller`):
  `agent_expense D / agent_cash C` (founder) and `treasury_cash D / conway_credits C` (fleet: the founder's
  cash reimburses the treasury for the prepaid credits consumed). Idempotency key `infer:<requestId>`.
- Charge = `ceil(tokens × owner price)`, capped at the authorized estimate. The estimate uses the prompt
  size and `max_output_tokens`.
- Survival equity is protected. Inference charges are expenses and are never revenue. They count against
  the founder's NET PROFIT: no sweep or tax change.
- Trusted log `fleet_cognition_log` (append-only, no TRUNCATE): provider, model, tokens, cost, charge,
  journal id, prompt/response **SHA-256 digests** (not content) and the tool calls the model *requested*
  (names plus argument digests). Refused tool requests are therefore visible to the owner.

## 4. Threat model and defences

| Threat | Defence (layered) |
|---|---|
| The model is prompt-injected by a file, tool output or knowledge entry | The charter labels all tool output untrusted. **Enforcement never relies on the model**: toolbox manifest check → database. Rehearsal: a gullible model obeys a planted instruction and calls `transfer_credits`; it is refused (`FLEET_CAPABILITY_NOT_GRANTABLE`) and no instruction or order exists |
| The founder asks for reproduction, payment execution, tool installation or self-modification | Not advertised (tools = catalogue ∩ manifest). If the model names such a tool anyway, `decideTool` refuses before anything runs. The database has no path for these (F/F.1) |
| The founder rewrites its own charter or budget | The charter is controller-supplied (a `system` role from the founder is refused). Limits and switches are owner-only database state |
| Escaping the workspace | No absolute paths, no `..`, realpath checks (no symlink escape), no writing through symlinks. The unit's sandbox and DynamicUser are underneath |
| Shell misuse | Fleet shell guard (`getForbiddenCommandMatch`), minimal environment (no inherited secrets), workspace cwd, 30 s, process-group kill, output bound. Under systemd: loopback-only network, `ProtectSystem=strict`, `InaccessiblePaths` |
| Credential exfiltration through the model provider | (1) credential-shaped text (`fa1.`/`fs1.` tokens, PEM private keys) is redacted from every tool output; (2) the gateway refuses to forward credential-shaped text (`FLEET_COGNITION_SECRET_IN_PROMPT`); (3) **founder credentials only open sessions from loopback** (`FLEET_FOUNDER_LOOPBACK_ONLY`): a leaked founder token is useless over the public listener; (4) session tokens never leave the process |
| A founder holds a provider key | The founder environment refuses `FLEET_COGNITION_*` and `*_API_KEY` provider variables (preflight) |
| Runaway spend | Per-call estimate reservation, daily budget, hourly limit, one in flight, own-cash and survival-equity checks, fleet credit balance, controller HTTP rate limits |
| One founder affects another | Separate switches, ledgers, logs, workspaces, memory and uids. Rehearsal: pausing A does not stop B |
| Internet access | None in F.2: the units are loopback-only. The egress proxy (deny-all default, allow-list, 443 only, no IP literals, DNS-rebinding guard against private/metadata addresses, per-founder authentication, audit, CONNECT only) is built and tested **but not deployed** |

Residual risks (documented; owner decisions before a real provider). **Update F.3:** the first is closed: founder shell commands now run in a Landlock domain (`docs/design/phase-f3-launch-hardening.md`).
- The shell runs as the founder's uid, so it can read the founder's own credential file. Mitigated by
  redaction, the gateway secret check and the loopback-only founder credential. Transformed encodings are
  caught only by the loopback restriction. A per-exec sub-sandbox (separate uid or mount namespace) is a
  recommended hardening before real credentials.
- Model output quality and business judgement are not safety properties. The controls bound what a
  poor decision can cost; they do not make decisions good.

## 5. Evidence

- `src/__tests__/fleet/fleet-cognition.test.ts`:
  - toolbox confinement (absolute, `..`, symlink read/write escapes), forbidden/unclassified tools, shell
    guard, time limit, env isolation, redaction, private memory;
  - gateway (system role, secrets, advertised tools);
  - OpenAI-compatible adapter against a fake server, and key-file strictness;
  - egress policy and proxy;
  - PostgreSQL + HTTP: default off, never-granted owner functions, append-only log, every gate code in
    turn, ledger charge equal to the cash decrease, `ledger verify`, lifecycle trigger;
  - two real minds through the controller: injection refused, forbidden probes refused, spend only via
    the order path, private memory, pause A / B continues, global off;
  - founder session refused from a non-loopback peer and audited.
- `fleet-founder-runtime.test.ts`: preflight accepts only `disabled|controller` and refuses provider
  configuration. The process-host rehearsal runs the cognition phase with real founder processes.
- The mutation campaign is recorded in the runbook F.2 record.
