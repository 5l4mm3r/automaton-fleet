# Phase E — Central treasury, double-entry ledger and custody boundary (schema v10)

Status: **DEPLOYED 2026-09-25** (runtime `f48f912`, build `e14720c4…f429`, schema v10); record in `docs/fleet-production-runbook.md` (Stage E).
Everything is **inert**:
- no real custody credential exists;
- no provider integration exists;
- custody execution is pinned off by a database CHECK constraint;
- `REAL_PAYMENTS_ENABLED`, replication and owner distributions stay off;
- Genesis has not started and the population is zero.

## E1. Invariant

The fleet treasury owns custody. The ledger is the only economic truth.

Agents hold **virtual allocations** and submit **structured spend orders**. FleetController decides *what* should be paid. An isolated **custody executor** decides *how*: it has its own OS user, DB role and service, and would execute only already-authorized instructions.

No agent, Claude, ChatGPT or Operator API principal has custody secrets, can sign, or can name a raw payment address. Agents can only name an owner-enrolled destination id.

| Layer | Identity | Can do |
|---|---|---|
| Agent | `fleet_agent_login` via the controller | `api_spend_request`, `api_spend_cancel`, `api_ledger_summary`. Its own orders only. |
| FleetController | `fleet_service_login` | `svc_expire_payment_orders` (reaper), `svc_issue_payment_instruction`. The latter always refuses in v10. |
| Custody executor | OS user `automaton-fleet-custody`, DB `fleet_custody_login` | `cx_ping`, `cx_claim_instruction`, `cx_report_result`. No table privilege. |
| FleetAdmin (owner) | schema owner via `fleet:admin ledger-*` | Named `fleet_admin_*` / `fleet_destination_*` / `fleet_estate_*` functions. |
| Operator API / Claude / ChatGPT | `fleet_operator_login` | Nothing in the ledger. The shell guard refuses every ledger and custody surface. |

## E2. Ledger

The ledger is append-only and double-entry, with hash-chain provenance and idempotency. Its tables:
- `fleet_ledger_classes`: 18 fixed classes (fleet and agent scope), each with a normal side and a non-negative flag;
- `fleet_ledger_accounts`: immutable;
- `fleet_ledger_kinds` and `fleet_ledger_rules`: the posting grammar, i.e. which (class, side) pairs each journal kind may touch and which sources may post it;
- `fleet_ledger_journal` and `fleet_ledger_postings`;
- `fleet_ledger_head`.

Enforcement is in the database, in depth. The mutation campaign proves each layer separately.

1. **Single writer.** `fleet_ledger_post` is owner-only and never granted. Every write goes through it. A write guard GUC is set only inside it (`FLEET_LEDGER_DIRECT_WRITE` otherwise). The privilege audit proves that no other function writes a ledger table or mentions the guard.
2. **Grammar.** A BEFORE INSERT trigger refuses any (kind, class, side) outside `fleet_ledger_rules` (`FLEET_LEDGER_RULE`). Postings must be in their journal's own transaction (`FLEET_LEDGER_IMMUTABLE`).
3. **Balance.** Every journal must have ≥ 2 postings with Σdebit = Σcredit. This is checked immediately in `fleet_ledger_post`, and again by deferred constraint triggers at commit.
4. **Non-negative.** Every non-negative class stays ≥ 0, checked immediately and again deferred. The deferred triggers are SECURITY DEFINER, because at COMMIT they run as the session role.
5. **Scope.** A non-multi-agent journal touches only its own agent's accounts (`FLEET_LEDGER_SCOPE`).
6. **Append-only.** There is no UPDATE, DELETE or TRUNCATE on the journal, postings, accounts or grammar. The one exception: `entry_hash` is filled once, inside the posting transaction.
7. **Hash chain.** `entry_hash = sha256(prev_hash | canonical(journal + postings))`, and the head row is locked FOR UPDATE. `fleet_ledger_verify()` recomputes the whole chain and the balances; doctor runs it.
8. **Idempotency.** The same key with the same content returns the same journal. A different content is refused (`FLEET_LEDGER_IDEMPOTENCY_CONFLICT`). External references are unique per kind.
9. **Corrections are reversals.** A reversal is the exact mirror of the original, at most once, never a reversal of a reversal, never for order journals.

Balances are always derived from postings (`fleet_ledger_balance`). No stored balance can drift.

## E3. Agent economics — protected principal and survival equity

```
recoverable     = cash + recoverable part of reserved asset purchases + recoverable value of held assets
survival equity = recoverable − protected principal − approved obligations
```

- **Survival rule (constitutional).** No spend may make survival equity negative (`FLEET_PROTECTED_CAPITAL`). Reserved expense funds are already committed and do not count as recoverable. Principal is purchasing capacity only for asset acquisitions whose recoverable value covers it.
- **Death before consumption.** When equity is exhausted, the agent can buy only fully recoverable assets. It dies (the estate recovers principal) before principal is consumed.
- **Capital.** `fleet_admin_agent_capital`:
  - `grant` gives the agent its own equity;
  - `principal` is a 4-posting advance that books the treasury receivable and the agent's liability.

## E4. Lifetime Fleet Contribution (LFC)

LFC is the `fleet:profit` balance.
- **Only one kind credits it:** `profit_contribution`.
- **Its amount is capped** at the agent's realized net profit not yet contributed: external revenue − expenses − fees − prior contributions (`FLEET_LFC_EXCEEDS_REALIZED_PROFIT`). It also keeps survival equity ≥ 0.
- **The grammar makes the exclusions structural.** Gross revenue, owner funding, principal, internal transfers and valuation cannot reach `fleet_profit`. Valuation changes go only to `unrealized_valuation`.

## E5. Spend-request state machine

```
requested → awaiting_owner | reserved | rejected
awaiting_owner → reserved | rejected | cancelled | expired
reserved → executing | cancelled | expired
executing → settled | failed
```

- **Identity is immutable.** Ledger links are set once and terminal states are final. Only the controller (deterministic policy) or the owner decides; agents and operator principals never do.
- **The decision is deterministic.** Hard checks run first:
  - agent active, not held, not frozen;
  - destination an active payee allowed for this agent;
  - allocation available;
  - survival rule.

  Policy comes second: the owner threshold (100.00) and the agent daily limit (50.00). Over-policy orders go to `awaiting_owner`; they are not rejected.
- **Reservation moves funds.** `agent_cash` moves to `agent_reserved` in the same transaction. Cancel, expiry (reaper) and failure release the funds. Settlement is possible only through the custody protocol.

## E6. Custody boundary (inert)

- **Controller.** `svc_issue_payment_instruction` refuses (`FLEET_CUSTODY_EXECUTION_DISABLED`). The instructions table refuses every insert while `custody_execution_enabled` is false, and `CHECK (NOT custody_execution_enabled)` pins it false. Turning it on is a constitutional change that needs a reviewed migration; no ordinary FleetAdmin override can do it.
- **Executor protocol.**
  - `cx_claim_instruction` works under a random lease; only its SHA-256 is stored.
  - `cx_report_result` requires the lease holder, exactly the instructed amount and one external reference. It is idempotent: a replay returns the same result, and a different second outcome is refused. It posts `spend_settlement` (or `owner_withdrawal_settlement`) or releases the reservation, atomically, and records assets for acquisitions.
  - The protocol is proven in a test schema with the pin removed.
- **Service** (`src/fleet/custody/`, `automaton-fleet-custody.service`):
  - no listener, loopback-only IP policy, `ProtectSystem=strict`;
  - no LoadCredential. It reads only `custody.env` (`root:automaton-fleet-custody 0640`, holding `FLEET_CUSTODY_DATABASE_URL` only).
  - **Startup refuses on:** root; a foreign credential; any custody/provider credential (none exists in v10); a safety switch on; the wrong DB login or role membership; schema ≠ v10; execution enabled; a runtime-pin mismatch; a custody privilege-audit problem.
  - With no provider configured it never calls claim. A provider exception counts as failure, never settlement.

## E7. FleetAdmin authority

Every owner instruction writes an immutable `fleet_admin_instructions` row. The row holds:
- kind, parameters and the assessment (treasury position, reserve target, obligations);
- recommendation (`proceed` / `recommend_against`) and warnings;
- `override`, `warnings_acknowledged` and `auth_level`;
- the confirmation digest and the outcome.

- **Policy (owner authority).** Warnings return `needs_acknowledgement` and do not execute. With `--ack` the owner proceeds, and the row records `override = true`. The controller never vetoes the owner on policy preference.
- **Constitution / security / custody / availability (not overridable).** These return `refused` with `constitutional: true`:
  - protected capital;
  - insufficient allocation or treasury;
  - held, frozen or dead agent;
  - destination not active or not allowed;
  - custody execution disabled.

  No acknowledgement changes them.
- **Approvers.** The approver must be `operator:<owner>`. `fleet_require_operator_approver` refuses agents and operator principals (Claude/ChatGPT) at the decision function and again at the instruction-record guard.

## E8. Owner funding, withdrawals and destinations

- **Funding.** `fleet_admin_record_owner_funding` books capital already received into custody. It is bookkeeping and moves nothing. The external reference is required and unique.
- **Destinations.**
  - Enrollment is separate from payment approval. Only `reference_sha256` and a ≤12-character hint are stored; real details live only with custody.
  - A new destination is enrolled `pending`. It activates only after the cooldown (72 h) **and** with the one-time activation code shown once at enrollment (only its SHA-256 is stored).
  - It is immutable afterwards (revoke and re-enroll to change it), and revocation is final.
- **Withdrawals.** `fleet_admin_owner_withdrawal`:
  - **Hard:** the destination is an active owner destination, and treasury unallocated cash ≥ amount.
  - **Soft:** below the reserve target, or below treasury obligations. These are acknowledgeable.
  - **Strong auth:** at or above 500.00 the withdrawal becomes `pending_confirmation` with a one-time code (15 min). `fleet_admin_confirm` by the same owner places the order.
  - Placing it reserves funds (`treasury_cash → custody_clearing`). It is never executed in v10, and **no automatic owner distribution exists**.

## E9. Assets and estates

Every asset (`fleet_assets`) has an economic-owner account: the agent's `agent_assets` or the treasury's `fleet:assets`. It also has an authority agent, an acquisition basis, a recoverable value and a disposition policy. Its provenance is immutable, and assets cannot be deleted.

Estates (owner-driven; not wired to the lifecycle in v10):
- `fleet_estate_open` (dying or dead agents only) cancels open orders and releases their funds;
- `fleet_estate_settle`:
  1. recovers principal from cash;
  2. writes off the unrecoverable remainder;
  3. moves the remaining cash and assets to the treasury;
  4. moves every asset's economic ownership to `fleet:assets`.

`fleet_estate_attention()` (doctor) reports assets under dead agents, dead agents with balances, and ownerless assets.

## E10. Legacy reconciliation (no competing truth)

**Frozen by `FLEET_LEGACY_SUPERSEDED` triggers.** Seven v5 money records are frozen, with history kept and never deleted:
- `fleet_agent_ledger`, `fleet_balance_observations`, `fleet_treasury_ledger`;
- `fleet_sweep_plans`, `fleet_owner_distributions`, `fleet_custody_transfers`;
- `fleet_spend_requests`.

At migration, `fleet_legacy_economics` records each table's row count and the SHA-256 of its rows.

**Kept as registers.** Treasury policy, obligations, capital allocations (plans and approvals), sweep reductions and wallet custody (freeze).

**Code changes.**
- `api_request_spend` and `/v1/wallet/spend-request` return `FLEET_LEGACY_SUPERSEDED`. The v10 path is `POST /v1/spend/request`, `POST /v1/spend/cancel` and `GET /v1/ledger`.
- `recordDeployment` and `completeAllocation` no longer duplicate money into the v5 ledger.

The migration invents no opening balances: the ledger starts empty (production had no economic activity).

## E11. Least privilege

- **Roles.** New roles `fleet_custody` / `fleet_custody_login` (`scripts/fleet-db-roles.sql`). Passwords go through `custody.env` via `fleet-db-setup.sh`. `fleet-os-setup.sh` creates the OS user, `custody.env` and the unit.
- **Privilege audit** (`auditPrivileges` / `ledgerSurfaceProblems`), which also runs for doctor and each service's self-check:
  - the custody role executes only `cx_*` and holds no table privilege;
  - the `cx_*` functions write and call only their allow-lists;
  - only `fleet_ledger_post` writes the ledger;
  - the custody pin CHECK is present;
  - the 14 ledger/order/destination/instruction guard triggers exist and are enabled.
- **Shell guard.** The agent shell guard refuses `custody.env`, `automaton-fleet-custody`, `cx_*`, `fleet_ledger_*`, `fleet_payment_*`, `fleet_admin_*` and the `ledger-*` CLI commands.

## E12. Proof

- **`src/__tests__/fleet/fleet-ledger.test.ts`** (26 tests, real roles, ephemeral PostgreSQL). It covers:
  - the privilege isolation matrix;
  - direct writes, updates, deletes, truncates and hand-opened guards;
  - grammar, balance, non-negative and scope;
  - idempotency and external-reference uniqueness;
  - hash-chain tamper detection;
  - reversals;
  - spend orders: own allocation, idempotency, destinations, malformed input, cancel, immutable identity;
  - concurrency: 12 parallel orders never over-reserve;
  - policy vs owner override with the audit row;
  - constitutional refusals, including held and frozen agents;
  - agents and Claude/ChatGPT principals never approve;
  - protected principal and survival equity;
  - TTL expiry via the service role;
  - HTTP end to end, including the reaper;
  - custody disabled, and the executor protocol (lease, exact amount, idempotency, failure release, LFC cap);
  - LFC exclusions;
  - destinations (cooldown, one-time code, immutability, no secret stored);
  - owner withdrawals (hard, soft, strong two-step);
  - estates (recovery, write-off, no orphaned asset);
  - legacy supersession and digests;
  - static-audit mutations;
  - the accounting identity;
  - a production-shaped v9 → v10 upgrade.
- **`src/__tests__/fleet/fleet-custody.test.ts`**: the executor's fail-closed startup, no provider, inert against a real database, the shell guard.
- **Mutation campaign:** 30 SQL mutants, 29 killed. The survivor, M19, is a redundant layer: the approver check in `fleet_admin_spend_decision` is also enforced by the admin-instruction guard, and M19b, which removes both, is killed.

## E13. Out of scope (next phases)

- **Provider integration** (bank, exchange, chain, Conway) and real custody credentials.
- **Enabling custody execution**, which needs a constitutional migration and owner approval.
- **Automatic profit contributions or physical sweeps** (contribution exists only as an owner ledger instruction).
- **Estate wiring** into the lifecycle reaper, and Genesis.
- **Egress policy** for the custody executor once a provider exists.
