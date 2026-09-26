# 24 — Phase D3: Claude Fleet Operator Channel (controlled operator actions)

> **IMPLEMENTED LOCALLY - NOT DEPLOYED**
>
> Schema **v9** exists only in this working tree. Production (checked live on 2026-09-25) is:
> - runtime `4d6a0be`, schema **v8**;
> - Operator API read-only;
> - principals `bridge-claude` (read) and `bridge-chatgpt` (read).
>
> Nothing in this chapter is live until the D3 deployment gate (§9) is approved and
> executed. Chapters 03, 06, 07 and 08 describe the **deployed** B2/D/D2 system and stay
> valid for production. This chapter documents D3 as an **extension** of them.

Design and adversarial review: `docs/design/phase-d3-operator-actions.md`.
Source: `src/fleet/postgres/migrations-phase9.ts` and the D3 changes listed in §8.

## 1. What changed (one paragraph)

The existing channel gains two things:
- **Tier 2 reads:** lifecycle health, runtime verification, reservations, orphans,
  proposals and the operator action ledger.
- **Tier 3 controlled operations:**
  - EXECUTE: hold/release an agent, request a health challenge, revoke sessions,
    reconcile the lifecycle;
  - PROPOSE: quarantine, terminate, revoke credential.

The channel is unchanged: Claude → `fleet-operator` MCP → Phase D bridge → restricted
SSH tunnel → Operator API → PostgreSQL. Each action is one named database function with
a closed schema, bound to the signed body. Each is gated by a new, separate kill switch
(default off) and by new scopes that only a newly enrolled principal can hold. Every
action is recorded in an immutable ledger. Proposals execute only through an owner-only
function that refuses operator principals. The B2 read path (STABLE functions, READ ONLY
transactions) is unchanged.

## 2. Schema v9 (`operator_actions_controlled`)

| Object | Change |
|---|---|
| `fleet_operator_principals` | scope CHECK widened to 6 scopes (`+ops.read.lifecycle, ops.act.agents, ops.propose.agents`); new CHECK `fleet_operator_principals_chatgpt_read_only` (ChatGPT ⊆ status+agents). Existing rows valid. |
| `fleet_operator_state` | `operator_actions_enabled boolean NOT NULL DEFAULT false` (the mutation kill switch; no CHECK against the API switch, so disabling the API never fails). |
| `fleet_operator_routes` | CHECKs replaced: `(GET\|POST) /v1/operator/…`, 6 scopes, 17 functions, `fleet_operator_routes_method_matches_fn` (GET ⇔ read function), `fleet_operator_routes_post_scoped` (POST ⇒ act/propose scope and `kinds = {bridge_claude}`); 12 new rows (6 GET, 6 POST). |
| `fleet_agents` | `operator_hold_at`, `operator_hold_by` (CHECK `op:op_<ULID>` or `operator:<name>`), `operator_hold_reason` (≤ 200), `challenge_requested_at`; CHECK hold columns complete. |
| `fleet_operator_actions` (new) | the append-only action ledger (see the design doc §3), `UNIQUE (principal_id, action, idempotency_key)`, `(decision = 'rejected') = (failure_code IS NOT NULL)`, no UPDATE/DELETE/TRUNCATE. |
| `fleet_operator_proposals` (new) | pending → approved/rejected/expired, once; guard trigger (only with `fleet.proposal_decision=on`, set only by owner functions); identity and expiry immutable; `expires_at ≤ created_at + 7 days`; no DELETE/TRUNCATE. |
| Functions (new) | `fleet_operator_begin` (internal admission, v8 logic + mode), `op_begin_action`, `fleet_operator_action_ok`, `fleet_operator_body`, `fleet_operator_params`, `fleet_operator_idempotent`, `fleet_operator_agent_state`, `fleet_operator_record_action`, `fleet_operator_conflict`, 5 `op_act_*`, `op_propose_agent_action`, 6 Tier 2 read functions, owner-only `fleet_operator_proposal_decide`, `fleet_agent_hold_set`, `fleet_agent_hold_release`. |
| Functions (replaced) | `op_begin_request` (same signature; SQL wrapper, GET only), `fleet_authenticate` (v7 + the hold clause), `svc_issue_challenge` (v5 + operator request). The B2 agent view `fleet_operator_agent_json` is deliberately **unchanged** (deployed strict validators). |
| Grants | `grant-operator-role` grants EXECUTE on the 21 functions in `OPERATOR_API_FUNCTIONS`. The operator role has no table privileges, and no EXECUTE on the owner functions, termination or holds. |

Expected v9 deltas over the v8 counts in chapter 03 §5:
- 2 tables and 2 sequences (`seq` bigserials);
- 22 new functions (3 replaced);
- 5 new triggers;
- 12 route rows (17 total).

## 3. Scopes and principals

| Scope | Grants | Kinds |
|---|---|---|
| `ops.read.lifecycle` | Tier 2 lifecycle reads | bridge_claude |
| `ops.act.agents` | EXECUTE actions | bridge_claude |
| `ops.propose.agents` | proposals | bridge_claude |

Existing production principals keep their scopes, because scopes are immutable. To use
D3 the owner must enrol a **new** principal, e.g. `claude-operator` with all 6 scopes and
a new key, and point the bridge config at it (§9).

## 4. Routes

| Method + path | Function | Scope | Body fields (all strings) |
|---|---|---|---|
| GET `/v1/operator/lifecycle` | `op_lifecycle_health` | ops.read.lifecycle | — |
| GET `/v1/operator/runtime` | `op_runtime_status` (+ pinned and release identity from the process) | ops.read.status | — |
| GET `/v1/operator/reservations?after=<ULID>&limit=` | `op_list_reservations` | ops.read.lifecycle | — |
| GET `/v1/operator/orphans?after=<seq>&limit=` | `op_list_orphans` | ops.read.lifecycle | — |
| GET `/v1/operator/proposals?after=<seq>&limit=` | `op_list_proposals` | ops.read.lifecycle | — |
| GET `/v1/operator/actions?after=<seq>&limit=` | `op_list_actions` | ops.read.lifecycle | — |
| POST `/v1/operator/actions/hold-agent` | `op_act_hold_agent` | ops.act.agents | agentId, reason, idempotencyKey |
| POST `/v1/operator/actions/release-agent-hold` | `op_act_release_agent_hold` | ops.act.agents | agentId, reason, idempotencyKey |
| POST `/v1/operator/actions/request-health-challenge` | `op_act_request_health_challenge` | ops.act.agents | agentId, idempotencyKey, reason? |
| POST `/v1/operator/actions/revoke-agent-sessions` | `op_act_revoke_agent_sessions` | ops.act.agents | agentId, reason, idempotencyKey |
| POST `/v1/operator/actions/reconcile-lifecycle` | `op_act_reconcile_lifecycle` | ops.act.agents | idempotencyKey, reason? |
| POST `/v1/operator/proposals` | `op_propose_agent_action` | ops.propose.agents | kind, agentId, reason, idempotencyKey |

Field formats:
- agentId: an upper-case ULID.
- reason: 1–200 characters, with no C0, DEL, C1 or lone surrogates.
- idempotencyKey: `^[A-Za-z0-9_-]{16,64}$`.
- kind: one of `quarantine_agent`, `terminate_agent`, `revoke_agent_credential`.

The body is exactly `canonicalActionBody(fields)`. Action responses have the form
`{actionId, action, decision, code, targetAgentId, previousState, requestedState, result{…}, proposalId, idempotentReplay}`.
New error code: `FLEET_OP_ACTIONS_DISABLED` (503). New action decision codes:
`FLEET_OP_TARGET_NOT_FOUND`, `FLEET_OP_INVALID_STATE`, `FLEET_OP_HOLD_NOT_OWNED`,
`FLEET_OP_OWNER_GATED`, `FLEET_OP_TOO_MANY_PROPOSALS`,
`FLEET_OP_IDEMPOTENCY_CONFLICT`.

## 5. MCP tools (Claude catalogue 5 → 17; ChatGPT unchanged at 4)

- **Tier 2 reads** (annotations identical to B2):
  - `fleet_lifecycle_health`
  - `fleet_runtime_verification`
  - `fleet_list_reservations`
  - `fleet_list_orphans`
  - `fleet_list_proposals`
  - `fleet_list_operator_actions`
- **Tier 3** (`readOnlyHint:false`, `openWorldHint:false`):
  - `fleet_hold_agent`
  - `fleet_release_agent_hold`
  - `fleet_request_health_challenge`
  - `fleet_revoke_agent_sessions`
  - `fleet_reconcile_lifecycle` (`destructiveHint:true`: it applies the reaper policy)
  - `fleet_propose_agent_action`

MCP server version 1.2.0.

## 6. Owner CLI (owner credential; never reachable through the Operator API)

```
pnpm fleet:admin operator-actions enable|disable <reason…>   # mutation kill switch (needs operator-api enabled)
pnpm fleet:admin proposal-list [all]
pnpm fleet:admin proposal-approve <proposalId> [note…]        # executes (quarantine / terminate / revoke credential)
pnpm fleet:admin proposal-reject <proposalId> [note…]
pnpm fleet:admin agent-hold <agentId> <reason…>               # owner hold: operators can never release it
pnpm fleet:admin agent-release-hold <agentId>
```

`operator-api disable` and `operator-revoke-all` now also turn actions off.

## 7. Security properties (each covered by tests; see §8)

- **No arbitrary shell, SSH, HTTP, SQL, filesystem, route or secret access.**
  - The only reachable operations are the 17 named tools, each with a closed schema.
  - There is no generic tool or client method.
  - The route map is default-deny, enforced by CHECKs and the verifier.
  - The database uses bound parameters and allows no dynamic SQL (static audit).
- **Claude cannot grant itself scopes.** Scopes are immutable, enrolment is owner-CLI
  only, and ChatGPT is barred by CHECK and the CLI.
- **Claude cannot approve its own action.** There is no route and no EXECUTE on the
  decision function, and the approver rule refuses operator principals by id, by name
  and in their `op:`/`op_` forms.
- **RED capabilities are unreachable.** None has a route, function, tool or proposal
  kind.
- **Every mutation is attributable and audited.** The ledger row and the event are
  written atomically with the effect, the ledger is append-only, and the JSONL line
  records the action and decision.
- **The kill switch disables mutation.** Admission and the action function both check
  both switches, so a request admitted before the switch was turned off cannot execute.
- **Reads unchanged.** The B0/B2/D/D2/C suites stay green (§8).

## 8. Implementation record (local)

All of this is local and uncommitted on `fleet-development`, based on `efad214`.

**New files:**
- `src/fleet/postgres/migrations-phase9.ts` (923 lines)
- `src/__tests__/fleet/operator-actions.test.ts` (17 tests)
- `docs/design/phase-d3-operator-actions.md`
- this chapter

**Modified (29 files, +1590/−169):**

| Area | Files |
|---|---|
| Database | `migrations.ts` (v9 registration, operator function lists, action allow-lists) |
| Privilege audit | `privileges.ts` (per-function D3 write/call rules; GET⇔read / POST⇔action route audit) |
| Store | `store.ts` (`capabilityScope` returns `held`; `operatorOverview` adds actions and pending proposals) |
| Operator API | `route-policy.ts`, `canonical.ts`, `gateway.ts`, `server.ts`, `responses.ts`, `main.ts`, `admin.ts` |
| Controller | `service/server.ts` (`routeDecision`: `held` = witness allow-list), `doctor.ts` ("operator actions" line) |
| Owner CLI | `postgres/cli.ts` (`operator-actions`, `proposal-*`, `agent-hold`, `agent-release-hold`) |
| Bridge / MCP | `client.ts`, `validate.ts`, `errors.ts`, `mcp-core.ts`, `mcp.ts` |
| Agent guards | `self-mod/code.ts` (migrations-phase9 protected), `policy-rules/command-safety.ts` (D3 commands and functions forbidden) |
| Existing tests | Updated for v9 (version numbers, the widened route/function sets, the admission logic moved into `fleet_operator_begin`). Every guarantee is kept; the begin-injection tests now target the function that holds the logic and also cover the wrapper. |
| Docs | `docs/fleet-production-runbook.md` (Stage D3 draft) |

**Tests (2026-09-25, dev VM):**
- `tsc --noEmit`: clean.
- Full `src/__tests__/fleet`: 21 files, **521 passed, 1 skipped, 1 failed**. The failure
  is `fleet-phase2` "migrations are idempotent and safe to run concurrently" (`tuple
  concurrently updated`): the documented pre-existing **FLEET-KI-1**, unchanged by D3.
  `fleet-witness` was fixed and re-run (26/26).
- New `operator-actions.test.ts`: **17/17**.
- `test:operator`: 71/71.
- `test:bridge`: 43/43.
- `test:chatgpt`: 15/15.
- `test:redact`: 88/88.
- `bridge-tunnel` "escalates to SIGKILL": passes alone and in the full run. It failed
  once under heavy parallel load (a 4-second timing bound); `tunnel.ts` is unchanged.

**Security mutation campaign:** 26 targeted mutations, **25 killed**. The one survivor
(M21, dropping the "POST routes are bridge_claude-only" verifier rule) is an
*equivalent* mutant: the "ChatGPT may only hold status/agents scopes" rule rejects the
same policies, because every POST scope is non-ChatGPT. What was mutated:

| Area | Mutations |
|---|---|
| `fleet_operator_action_ok` | digest binding, re-execution, kill switch |
| Admission | read-mode method filter, action kill switch, per-principal cap |
| Holds | hold ownership, `fleet_authenticate` hold clause, hold state validation |
| Decision function | approver rule, revoked proposer, expiry |
| Other database | idempotency conflict, proposal guard trigger, ChatGPT CHECK, challenge request |
| Service / store | `routeDecision`, `capabilityScope` |
| Server | canonical body, closed body |
| Admin / CLI | API disable clears actions, CLI ChatGPT scopes |
| MCP | enum enforcement |
| Static audit | action write allow-list, action call allow-list |

**Protocol-level MCP proof:**
- The in-process `FleetMcpServer` drives the real bridge client against the real
  Operator API.
- Action tools return the "controlled operator action" model view.
- 12 hostile calls are refused with JSON-RPC −32602 before reaching the bridge:
  generic command/query/endpoint/approve/set-cap tools, path traversal, overlong or
  control-character reasons, non-enum kinds, extra properties.
- A live `claude -p` session against a test controller was **not** run. The stdio
  transport is unchanged since D2, and D2's stdio end-to-end test passes.


## 9. Deployment gate (NOT EXECUTED — requires owner approval)

**Nothing below has been executed.** Each row needs explicit owner approval.
- **Commit and push.** The D3 work is uncommitted. Committing is gate D3-1, and it waits
  for approval.
- **Runtime release.** D3 changes the controller runtime: `service/server.ts`,
  `store.ts`, `doctor.ts`, the migrations, and agent-side guards in `command-safety.ts`
  and `self-mod/code.ts`. So D3 needs a new pinned runtime release (commit, build ID,
  approval) and a planned outage for the v8→v9 migration. As a side effect, the D3
  release also closes drift **P-6** (chapter 14 §7): the pinned agent runtime will then
  carry the Phase D/C agent-side guards.
- **Schema.** v9 is additive. It replaces `op_begin_request` (same behaviour, GET-only),
  `fleet_authenticate` (adds the hold clause) and `svc_issue_challenge` (adds the
  operator request). There is no down-migration, so rolling back means restoring the
  pre-v9 dump.

Gate table (the same as the runbook's "Stage D3" draft):

| Gate | Action |
|---|---|
| D3-1 | Review; local commit; push to `fleet-origin` |
| D3-2 | VPS reproducible build (lockfile must stay `eee9dc2f…`) |
| D3-3 | `runtime.env` pins (keep `runtime.env.pre-d3`); stage and install the release; move the tooling checkout |
| D3-4 | Outage: stop the Operator API, adapter and controller; take a verified pre-v9 dump; `migrate-check` = exactly 8→9; `migrate`; `audit-privileges` |
| D3-5 | `approve-runtime`; start the services; doctor, verify 16/16, `fleet-verify-deployment.sh`, readiness |
| D3-6 | Production regression: `bridge-claude` reads; ChatGPT adapter unchanged |
| D3-7 | Keygen and enrolment of `claude-operator` (6 scopes, 30 days); point the bridge config at it |
| D3-8 | Owner: `operator-actions enable`; smoke test (lifecycle, runtime, reconcile, hold on an unknown ULID → recorded refusal, ledger read); optionally disable again |

Rollback:
- **Immediate:** `operator-actions disable`, `operator-api disable` or
  `operator-revoke`.
- **Full:** restore the pre-v9 dump and `runtime.env.pre-d3`, point `current` back to
  `releases/4d6a0be…`, restart and verify.

**Known risks (residual):**
- **Compromised Operator API process.** It can skip signature checks (B2 residual) and
  call the named action functions directly. It is still bounded by the database
  re-validation, the hourly caps, the kill switch and the ledger. It can never approve,
  terminate or change the cap.
- **Holds don't stop compute.** A hold restricts fleet authority. It doesn't stop
  compute inside a sandbox, and it doesn't stop the agent's own upstream Conway tools
  (for example `topup_credits`, chapter 15).
- **Reconcile applies the reaper policy.** `reconcile_lifecycle` can end agents that the
  configured policy already considers dead (the same as the controller's own reaper).
- **Proposal reasons are LLM-written text.** Owners should read them as untrusted.
- **Human confirmation depends on Claude Code settings.** It relies on the six action
  tools *not* being allow-listed.
- **Key expiry.** The `bridge-claude` key expires on 2026-10-24. The new
  `claude-operator` key needs its own rotation schedule.

