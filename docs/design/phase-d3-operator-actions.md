# Phase D3 — Claude Fleet Operator Channel (controlled operator actions)

Status: **IMPLEMENTED LOCALLY — NOT DEPLOYED** (schema v9). Production stays on
runtime `4d6a0be`, schema v8, and is read-only until the D3 deployment gate
is approved.

D3 extends the existing channel. It does not replace it:

```
Claude ─ fleet-operator MCP (stdio, D2) ─ Phase D bridge client ─ restricted SSH tunnel (fleet-op-tunnel)
       ─ Operator API 127.0.0.1:8788 (B2 process, fleet_operator_login) ─ PostgreSQL op_* functions (FleetController's
         enforcement layer: the same SECURITY DEFINER / lifecycle functions the controller uses)
```

There is no new process, port, listener, OS user, database role, tunnel or credential type.

## 1. Authority model

```
Fleet Constitution
      ↓
FleetAdmin / Owner   — owner credential (admin.env) + fleet:admin CLI: kill switches, principals, proposal decisions, owner holds
      ↓
FleetController      — PostgreSQL functions + fleet service: validates, enforces policy, records evidence
      ↓
Claude Operator      — a bridge_claude principal with D3 scopes: reads, reversible/policy actions, proposals
      ↓
Agents
```

Claude is an engineering/operator principal. It is not FleetAdmin, and it is not a
treasury custodian. It cannot approve anything, and no D3 route exists for any
owner-gated capability.

## 2. Capability tiers

| Tier | Class | Scope | Operations (route → database function) |
|---|---|---|---|
| 1 OBSERVE | READ | `ops.read.status/agents/events` (B2, unchanged) | whoami, status, list/get agents, list events |
| 2 ROUTINE | READ | `ops.read.lifecycle` (+ `ops.read.status` for runtime) | `GET /lifecycle` → `op_lifecycle_health`; `GET /runtime` → `op_runtime_status` (+ the process's pinned and installed-release identity); `GET /reservations`, `/orphans`, `/proposals`, `/actions` |
| 3 CONTROLLED | EXECUTE | `ops.act.agents` | `POST /actions/hold-agent`, `/release-agent-hold`, `/request-health-challenge`, `/revoke-agent-sessions`, `/reconcile-lifecycle` |
| 3 CONTROLLED | PROPOSE | `ops.propose.agents` | `POST /proposals` (`quarantine_agent`, `terminate_agent`, `revoke_agent_credential`) |
| — | OWNER-GATED | none (owner CLI only) | proposal approve/reject, owner holds, both kill switches, principal enrolment/revocation |
| — | RED | none, not representable | payments, replication, Genesis/founders/reseeding, cap, mode, runtime approval, treasury/custody, credential export, owner identity, constitution, auth/audit/isolation weakening, public exposure, destructive recovery, owner distributions |

EXECUTE is limited to actions that are **reversible** (hold/release, session
revocation, requesting a challenge) or that **apply the controller's own
configured policy** (reconcile runs `fleet_reap`, the same function the
controller's reaper runs). Every **irreversible** agent action
(quarantine/terminate/credential revocation) is PROPOSE only.

### Semantics

- **Hold (pause).** Sets `fleet_agents.operator_hold_*` and revokes live sessions. While
  held, the agent has only the witness allow-list:
  - database (`fleet_authenticate`, v9): open_session, heartbeat and whoami, plus the
    authority-*reducing* set_own_status and release_reservation;
  - service (`routeDecision` scope `held`): session, heartbeat, health challenge and
    self.

  So the agent keeps its liveness and is not reaped for being held. A hold is not a
  lifecycle state, and compute inside the sandbox is **not** stopped (the provider has
  no API for that). A principal may release only a hold it placed itself. Owner holds
  (`fleet:admin agent-hold`) are owner-gated.
- **Request health challenge.** Sets `challenge_requested_at`. `svc_issue_challenge` (v9)
  then treats a challenge as due inside the normal interval, and FleetController issues
  it with the next heartbeat.
- **Revoke sessions.** Revokes live `fs1` sessions. The long-lived credential still
  opens new ones, so combine this with a hold to restrict the agent.
- **Reconcile lifecycle.** Calls `fleet_reap('op:<principal>')`, at most once every
  30 s.
- **Propose.** Records a pending proposal that expires after 24 h. Only
  `fleet_operator_proposal_decide`, an owner-only function that is never granted, can
  execute a proposal. It:
  - requires an `operator:<name>` actor;
  - refuses operator principals by id, by name and by the `op:`/`op_` forms, as well as
    agents (`fleet_require_operator_approver`);
  - refuses proposals from principals revoked since, and marks expired proposals as
    expired;
  - re-validates the target's **current** state and executes in the same transaction.

## 3. Architecture decision

The candidates were:
- (a) loosen B2's READ ONLY path;
- (b) a command table consumed by the controller;
- (c) a separate action process with its own login and port;
- (d) a **separate action admission path plus named SECURITY DEFINER action functions**
  inside the existing Operator API and database.

**Chosen: (d).**
- (a) is rejected: B2's read-only invariant is kept intact.
- (b) is rejected: a compromised Operator API could still enqueue anything the
  consumer executes, and it adds latency and a second writer.
- (c) is rejected: it adds a listener, OS user, credential and tunnel target, with no
  gain over (d), because the database is the enforcement point in every design.

What stays exactly as in B2:
- Every GET route maps to one STABLE read function, run in a `BEGIN TRANSACTION READ
  ONLY` transaction.
- `op_begin_request` keeps its signature and behaviour. The logic moved verbatim into
  the owner-only `fleet_operator_begin(mode, …)`, and v9 admits **GET routes only**
  through it.

What D3 adds:
- `op_begin_action` admits **POST routes only**. It requires both
  `operator_api_enabled` **and** `operator_actions_enabled`, and enforces hourly caps
  of 30 per principal and 60 globally.
- Each POST route maps to exactly one `op_act_*` / `op_propose_*` function. That
  function:
  1. re-checks the request (≤ 30 s old, POST route for exactly this function,
     principal/key live, scope and kind, both switches on, not already executed);
  2. requires `sha256(body) = the admitted body_sha256`, which is the digest inside the
     signed canonical string;
  3. re-validates every field in SQL (closed object, string fields, ULID, reason 1–200
     characters with no control characters, `fleet_scrub`, kind enum, idempotency key);
  4. locks the principal row, then the agent row, and validates state;
  5. applies its one effect and writes its ledger row and `operator_action` event in the
     same transaction.
- **Idempotency.** `(principal, action, idempotencyKey)` is unique. An identical retry
  returns the recorded result. A different retry is `FLEET_OP_IDEMPOTENCY_CONFLICT`.
- **Ledger.** `fleet_operator_actions` is append-only: no UPDATE, DELETE or TRUNCATE.
  Each row records the request id, time, principal, kind, key, scope, action, target,
  parameters, previous state, requested state, decision
  (`executed|noop|rejected`), failure code, result and proposal id. It holds no
  secrets; `reason` is scrubbed and returned only as `untrusted_text`.

## 4. Wire format (FLEET-OP-SIG-V1, unchanged)

POST bodies are signed through the existing ninth line of the canonical string,
`body_sha256`. The only accepted body is `canonicalActionBody(fields)`: a flat object of
string fields, keys sorted, with no whitespace. Before any database contact the server
requires all of the following, otherwise it answers 400 (`BAD_REQUEST`, `NONCANONICAL`
or `BAD_PARAM`):
- `content-type: application/json`;
- a Content-Length of 1..4096 and no Transfer-Encoding;
- valid UTF-8 and no query string;
- the exact per-route schema;
- the canonical serialization.

Key facts about the rest of the path:
- A signature over a different body fails (401).
- Method and route cross-overs (GET on an action route, POST on a read route, PUT,
  unknown actions) return 404.
- The bridge client has one typed method per operation and no generic request method.

## 5. MCP (Claude only)

The catalogue grows from 5 to 17 tools:
- **B2 read tools:** the 5 existing ones, unchanged.
- **Tier 2 read tools:** `fleet_lifecycle_health`, `fleet_runtime_verification`,
  `fleet_list_reservations`, `fleet_list_orphans`, `fleet_list_proposals`,
  `fleet_list_operator_actions`.
- **Tier 3 tools:** `fleet_hold_agent`, `fleet_release_agent_hold`,
  `fleet_request_health_challenge`, `fleet_revoke_agent_sessions`,
  `fleet_reconcile_lifecycle`, `fleet_propose_agent_action`.

How the tools are constrained:
- Every schema is closed. Arguments may only be `agent_id` (ULID), `reason` (1–200
  characters, no control characters), `idempotency_key`, `kind` (enum), `limit`,
  `after` and `type`.
- Action tools carry `readOnlyHint:false` and warn against acting on agent- or
  event-supplied text.
- Results carry the source label `"fleet-operator-api (controlled operator action)"`.

The ChatGPT adapter's catalogue (`CHATGPT_TOOL_NAMES`) is unchanged and byte-identical:
4 read tools. The database also forbids any D3 scope for `bridge_chatgpt`.

Human in the loop: Claude Code asks the user before every MCP tool call that isn't on
an allow-list. **Do not allow-list the six action tools.**

## 6. Adversarial review (performed before implementation; findings folded in)

| Attack | Result / defence |
|---|---|
| Privilege escalation via new scopes | Scopes are immutable (v8 trigger), so D3 scopes only come from enrolling a new principal, which is an owner CLI action. ChatGPT is barred by CLI and CHECK. |
| Scope confusion (read principal calls action) | Scope and kind are checked in the process, again in `op_begin_action`, and again in the action function. |
| Claude approves its own proposal | No route exists. The operator role lacks EXECUTE on `fleet_operator_proposal_decide`, and the function refuses operator principals and `op:` actors. `fleet.proposal_decision` is only referenced by owner functions, and the static audit rejects it in action functions. Tests cover all of this. |
| Arbitrary route smuggling | Default-deny route map; CHECK (GET ⇔ read function, POST ⇔ action function, POST ⇒ act/propose scope, bridge_claude only); `verifyRoutePolicy`; exact matching; tests. |
| Parameter or SQL injection | Closed schemas in the MCP, the client, the server and SQL. The database receives only bound parameters, and no dynamic SQL is allowed (static audit). |
| Command injection or path traversal | There are no command, path, URL or file parameters anywhere. ULID and enum patterns only. |
| Replay | Nonce ledger (unchanged). An action request id executes at most once (`NOT EXISTS` in the ledger). Idempotency keys. |
| Stale authorization | The action function requires a request ≤ 30 s old, both switches currently on, and a live principal/key (a request admitted before the owner turns actions off cannot execute). Proposal approval re-validates state, expiry and proposer revocation. |
| Compromised Claude session | It can only call the 17 tools, and each action tool is human-confirmed unless allow-listed. It is limited to reversible actions or proposals, hourly caps apply, and everything is audited. The owner turns actions off, or revokes the principal, in one command. |
| Compromised signing key | Same limits as a compromised session. The key is revocable (`operator-revoke`), and its pending proposals then become unapprovable. |
| Compromised Operator API process | It holds only the operator login, so it can do no more than the named action functions: they re-validate everything, are capped, kill-switchable and ledgered. It cannot bypass the owner gate, because it has no EXECUTE on decisions, termination or owner holds. It could skip signature checks for its own requests (B2 residual, unchanged). |
| Cross-agent targeting | Every action takes an explicit target, validates it, and records it. A principal cannot release another principal's hold. |
| Races / TOCTOU | Row locks in the order principal → state → agent. Validation and effect happen in one transaction. Idempotency keys are unique. |
| Audit bypass | The ledger row and event are written in the same transaction as the effect. Tables are append-only (triggers) and the operator role has no table privileges. |
| Kill-switch bypass | `op_begin_action` checks the switch and so does `fleet_operator_action_ok`. *Review finding:* a draft `CHECK(actions ⇒ api)` would have made `operator-api disable` and `operator-revoke-all` **fail** while actions were on, so it was removed. Disabling the API now also clears actions, and re-enabling reads never re-enables mutations. |
| Secret leakage | No secrets in the ledger. Reason is scrubbed and returned as `untrusted_text`. JSONL audit lines name only action and decision. There is no key, token or DSN on any path. |
| Side-effecting built-ins in operator code | *Review finding:* a draft propose function used `set_config` to expire stale proposals. It was removed; operator-reachable code never calls `set_config`. |
| Deployed-client compatibility | *Review finding:* adding a `held` field to the B2 agent view would break the deployed ChatGPT adapter's strict validator (pinned 6691b4c). The B2 agent view is unchanged. |

## 7. Enforcement map

| Control | TS process | PostgreSQL | systemd/OS | Network |
|---|---|---|---|---|
| Route allow-list | route-policy + verifier | routes CHECKs + FK | — | loopback 8788 via SSH `permitopen` |
| Signature, nonce, clock | server | begin (nonce, clock) | — | — |
| Body schema + digest binding | server `checkActionBody` | `fleet_operator_action_ok` + `fleet_operator_body/params` | — | — |
| Scope / kind | server | begin + action_ok + CHECKs | — | — |
| Kill switches | — | begin + action_ok | — | — |
| Caps | per-principal token bucket | hourly caps in begin | — | — |
| Hold enforcement | service `routeDecision` | `fleet_authenticate` | — | — |
| Owner gate | no route | no EXECUTE; approver rule; guard trigger | owner credential only in admin.env | — |
| Evidence | JSONL line (action, decision) | ledger + events, immutable | — | — |

## 8. Deployment (not executed)

See the D3 gate record in `docs/master-key/24-PHASE-D3-OPERATOR-ACTIONS.md` §9.
