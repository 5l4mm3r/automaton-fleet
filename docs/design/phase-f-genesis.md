# Phase F — Genesis architecture and pre-Genesis integration (schema v11)

Status: implemented; deployment record in `docs/fleet-production-runbook.md` (Stage F).
The founders are **not** created. Genesis is disabled (`fleet_genesis_policy.genesis_enabled = false`)
and production population stays 0. Activating Genesis is a separate owner gate.

## F0. Integration drift closed

- **MCP identity.** The project MCP registration already pointed at `claude-operator.json`. The long-running Claude Code session had started its MCP process before the D3-7 switch, so it still carried `--config bridge-claude.json`.
  - The bridge now takes `--expect-principal <name>` (or `FLEET_BRIDGE_EXPECT_PRINCIPAL`). The first call in a process confirms the key's principal *name* through the Operator API; a mismatch fails every call with `IDENTITY_MISMATCH`.
  - The registration now carries `--expect-principal claude-operator`. Startup logs the configured principal id.
- **ChatGPT adapter.** It refuses `FLEET_CUSTODY_DATABASE_URL` (through `OPERATOR_FORBIDDEN_ENV`) and refuses to run if `custody.env` is readable.
  - The adapter and tunnel units (and the controller, Operator API and witness units) hide `custody.env` and the custody state directory.
  - The adapter artifact is rebuilt and re-pinned to the Phase F commit. Its authority is unchanged: principal `bridge-chatgpt`, scopes `ops.read.status` and `ops.read.agents`, 4 read tools.
- **Privilege-audit output.** `fleet:audit-privileges` PASS and doctor now name the custody roles and the ledger, custody and Genesis surfaces explicitly.

## F1. Origins, not a generic "create agent"

`fleet_agents.origin` takes one of these values. It is fixed at insert and immutable afterwards (origin guard trigger).

| Origin | How it is created | v11 |
|---|---|---|
| `genesis_founder` | Only by `fleet_genesis_provision`, inside its Genesis operation (`fleet.genesis_op` guard) | implemented, owner-gated |
| `reseed_founder` | Only after extinction, by owner policy | modelled; `refounding_enabled` pinned false (CHECK) |
| `reproduction_child` | A child of an existing agent; set automatically for every child insert | a founder parent is refused (`FLEET_REPRODUCTION_DISABLED`); reproduction execution pinned false (CHECK) |
| `dry_run_child` | The owner's dry-run child path | unchanged |
| `replacement` | A separately governed process | reserved; any insert is refused |
| `legacy` | Pre-v11 roots | unchanged |

- A Genesis authorization cannot enable reproduction: the founders' origin makes children impossible while execution is pinned off.
- The legacy replication path remains gated by `REAL_REPLICATION_ENABLED` and the database switch (both off).

## F2. Two independent founders

Each founder gets its own:
- agent id (ULID generated in the database);
- keyless identity address (a hash, with no private key; custody is the fleet treasury);
- `workspace_id` / `state_namespace`, unique and immutable;
- nine ledger accounts;
- lineage root (itself);
- credential, issued only at activation;
- sessions.

Founders share the constitution, the capability manifest `founder-v1`, the ledger grammar, the security boundaries and the same starting allocation. There is no prescribed business: the template carries no business idea.

- **Isolation (database).** Unique workspace, state and lineage columns; nothing can re-point them.
- **Isolation (runtime).** Separate directories derived from `workspace_id`, which the dry run checks as distinct and non-nested.
- **Knowledge.** Shared knowledge exists only as owner-promoted, attributed entries (F10), never as shared mutable cognition.

## F3. The authorization object (`fleet_genesis`)

**Immutable fields.**
- Id, kind, idempotency key, founder count, template version.
- Manifest id and SHA-256.
- Runtime repo, commit, build id and lockfile hash, pinned from the approved runtime at proposal.
- Economic-policy SHA-256 (ledger grammar, provenance map and economic model), allocation per founder, expiry, requester.
- `auth_sha256`, the SHA-256 of the canonical text of all of the above.

**Set-once fields.** Approver and approval time; founder ids; activation.

**Anti-replay and integrity.**
- **Single use:** terminal states are final; `consumed_at` is set at activation or rollback; only one Genesis can be in flight (partial unique index).
- **Idempotent proposal:** the same key and content return the same authorization; a different content is refused.
- **Immutable:** every row write needs the Genesis operation guard, and content columns never change.
- **Tamper detection:** approval and activation must present the exact `auth_sha256`. Every step re-hashes the stored row (`FLEET_GENESIS_TAMPERED`).
- **Expiry:** checked at approval, provisioning, attestation, funding and activation, and swept by the reaper (`svc_genesis_expire`).
- **Drift detection:** a change to the approved runtime or the economic policy after authorization blocks funding and activation (`FLEET_RUNTIME_MISMATCH`, `FLEET_POLICY_CHANGED`).
- **Who may act:** only `operator:<owner>`. `fleet_require_operator_approver` refuses agent ids, wallets and any Operator API principal name (Claude, ChatGPT).
  - No restricted role (agent, service, operator, custody) can execute any Genesis function.
  - Approval and activation also require the owner switch `genesis_enabled`.
  - Claude built and tested the mechanism; it did **not** enable Genesis or issue a production authorization.

## F4. State machine

```
proposed → approved → provisioning → attesting → funding_virtual → ready → activated
proposed → rejected | cancelled | expired          approved → cancelled | expired
provisioning | attesting | funding_virtual | ready → rolled_back
```

Every transition is logged in `fleet_genesis_transitions` and emits an event.

| Step | What happens |
|---|---|
| provision | Creates every founder as `reserved` (the cap is enforced by the counter trigger) with **no credential** |
| attest | Takes one founder's runtime/manifest/workspace evidence; a mismatch rolls the **whole** Genesis back in the same call |
| fund | Posts every allocation or none |
| activate | Issues every credential and makes every founder `active` in **one** transaction |

- **Partial-failure policy: roll back, deterministically.** Any founder failure, expiry or owner abort does all of the following:
  - fails every founder;
  - revokes any credential or session;
  - returns every allocation (`genesis_allocation_return`);
  - releases every slot;
  - consumes the authorization.

  A half-created founder never has authority: before activation no founder can authenticate.

## F5. Virtual starting capital

The ledger kind is `genesis_allocation` (`treasury_cash → agent_cash`), with provenance `genesis_allocation`. It needs treasury cash recorded beforehand, and the amount is owner-set in the authorization. No wallet transfer, payment or sweep happens.
- **Economics:** the allocation is reported separately (`genesisAllocation`). It is not revenue, not realized profit and not LFC.
- **Grammar:** it cannot touch revenue or `fleet_profit`.
- **No production amount** is set or funded in Phase F. Tests and the dry run use synthetic amounts.

## F6. Economic autonomy contract

**Operating loop:** observe → research → identify demand → estimate cost/time/risk → choose an experiment → spend order where needed → build/test/sell → record external results → update strategy.

**Opportunity universe:** legitimate digital products, services, software, research/data, marketplaces, content, supplier-fulfilled commerce and approved investment.

**Enforcement lives outside the prompt:**
- the database (ledger grammar, spend orders, capability checks);
- FleetController;
- the custody boundary;
- the runtime capability rule.

The prompt or personality is never the control. Internal fleet transfers are never revenue (F9).

## F7. Capability manifest

- **Database.**
  - `fleet_capability_classes`: 21 classes.
  - Five classes are **not grantable** (constitutional): `self_modification`, `tool.discovery`, `compute.provisioning`, `reproduction`, `custody.payment_execution`.
  - `fleet_capability_manifests` is versioned and content-hashed. An insert naming a non-grantable class is refused, and rows never change.
  - `fleet_agent_can()` enforces the fleet-mediated classes server-side: `spend.request` (order-insert trigger), `ledger.read`, `identity.claim_request` and `knowledge.*`. Agents that carry a manifest get exactly its grantable classes.
- **Runtime** (`src/fleet/capabilities.ts`).
  - Every runtime tool is classified (a test fails on any unclassified tool).
  - The rule `fleet.capability_manifest` is active when the founder unit sets `FLEET_CAPABILITY_MANIFEST=founder-v1`. It denies unclassified tools, non-grantable classes and anything not allowed; an unknown manifest id denies everything.
  - The compiled manifest's SHA-256 must equal the database manifest at attestation, and doctor checks it on every run.
  - Escalation paths are closed: the `fleet/` source is a self-modification boundary; the shell guard refuses `FLEET_CAPABILITY_MANIFEST=`, Genesis, manifest and vault surfaces; and tool discovery is not grantable.

## F8. Organisation Identity vault

- **Facts.** `fleet_org_identity_facts` is owner-only. There are 9 fixed fact keys, each with a sensitivity of `public`, `restricted` or `secret`. The table is **empty in Phase F**.
- **Claims.** An agent asks for **one** fact for a named workflow (`api_identity_request`, capability `identity.claim_request`). The owner decides, setting a TTL and a maximum number of reads.
- **Release.** `api_identity_fact` releases exactly that fact:
  - only to the claiming agent;
  - only while the claim is approved, unexpired and under its read limit;
  - **never** a `secret` fact.
- **No listing.** There is no listing function. Events log the fact's SHA-256, never its value, and changing a fact revokes its outstanding claims.
- **No fabrication.** Agents cannot invent legal facts: only the owner's authoritative values exist.

## F9. External revenue provenance

Every ledger kind carries a provenance:
- owner funding, treasury allocation, Genesis allocation, protected principal;
- internal transfer, reservation, expense;
- external customer revenue, refund, realized investment P&L, unrealized valuation;
- profit contribution, owner withdrawal, estate, correction.

External facts are recorded by `fleet_admin_record_external`, one of `external_revenue`, `external_refund`, `investment_realized_gain` or `investment_realized_loss`. Each requires:
- an external reference;
- the counterparty's SHA-256;
- a counterparty that is **not fleet-controlled**: not an agent identity, not an owner destination, not a registered fleet reference (`fleet_controlled_references`). Otherwise the call fails with `FLEET_INTERNAL_TRANSFER_NOT_REVENUE`.

Each fact is stored in `fleet_revenue_provenance`. `agent_transfer` can never touch revenue (grammar). Economics report external customer revenue, investment P&L and internal transfers separately.

## F10. Institutional knowledge

- **Private memory** stays in each founder's own state namespace.
- **Proposals.** `api_knowledge_propose` takes the origin agent, lineage and Genesis from the authenticated agent, never from the caller. It is rate-limited and content-hashed.
- **Promotion** (`fleet_knowledge_review`) is owner-only and attributed. Agents and Claude are refused.
- **Entries** must match their promoted proposal exactly (origin, lineage, Genesis, title, category, content, hash) and are immutable.
- **Reading.** Agents read promoted entries with their provenance (`api_knowledge_list`). They never see another agent's proposals or memory.

## F11. Death and estate integration

- **Economic death is immediate.** When an agent leaves the trusted states (dead, failed, terminating, orphaned), the `fleet_agents_death_freeze` trigger runs in the same transaction:
  1. revoke sessions and credentials;
  2. open the estate;
  3. cancel and release every pending order.

  A failure there is logged; it never blocks the lifecycle transition.
- **Settlement.** The reaper (`svc_settle_estates`) or the owner settles the estate:
  1. recover principal;
  2. write off the rest;
  3. move the residual cash and assets to the treasury;
  4. reassign asset ownership.

  Settlement happens exactly once and runs only after economic death, with nothing in flight.
- **Compute termination** stays a separate queue (`fleet_sandbox_terminations`). A dead agent has no authority even if its sandbox cannot be destroyed.

## F12. Reproduction eligibility (inert)

`fleet_reproduction_policy` pins `execution_enabled` false by CHECK and holds the thresholds. `fleet_reproduction_eligibility(agent)` assesses:
- realized net profit, LFC and external customer revenue;
- runway, obligations and protected principal;
- capital efficiency, free slots and treasury.

It always returns `eligible: false, executable: false` and lists the reasons. There is no execution path: founders cannot have children (origin guard), the replication switches are off, the cap stays 2 and the hard maximum 50.

## F13. Dry run

`pnpm fleet:admin genesis-dry-run` runs the whole workflow on the **real** schema in **one** transaction, then `ROLLBACK`. It uses synthetic funding, synthetic amounts, synthetic credentials (never written) and temporary directories.

**Scenario A:** founder 2 fails attestation. The whole Genesis rolls back, and replays are refused.

**Scenario B:** full activation. Checks:
- identities, workspaces, state and ledger accounts are independent;
- cap admission;
- runtime pin;
- manifest digest;
- balanced virtual allocations;
- LFC unchanged;
- no payment or custody instruction;
- reproduction refused;
- replays refused.

**After the rollback**, population, Genesis records, agents, ledger head, LFC, events and the Genesis switch all equal the pre-run snapshot.

## F14. Proof

- **`fleet-genesis.test.ts`** (22 tests):
  - the capability catalogue and AI-bridge tool surfaces;
  - the role isolation matrix;
  - agent, Claude and ChatGPT refusals;
  - the owner switch;
  - replay, idempotency, altered/tampered and expired authorizations; reaper rollback;
  - concurrent Genesis;
  - cap and constitutional maximum;
  - provisioning and attestation failures (runtime, manifest, a foreign workspace);
  - forged/advanced founders; shared-workspace attempts;
  - the allocation as never revenue or LFC, with grammar refusals;
  - internal counterparties refused; genuine revenue, refund and P&L provenance;
  - reproduction refused with switches on; payment paths closed;
  - manifest escalation, including a superuser-smuggled manifest;
  - death/quarantine freeze and the estate settlement race;
  - knowledge forgery;
  - identity-vault over-read (other agent, read limit, secret fact, no values in events);
  - policy and runtime drift;
  - Genesis surface audit mutations;
  - the dry run itself.
- **Mutation campaign:** 30 SQL mutants against the v11 enforcement points, **30 killed**. Three initial survivors exposed test gaps, which are now covered.

## Out of scope (owner gates / later phases)

- Enabling Genesis, recording treasury funding and choosing the real allocation.
- Activating the founders.
- Provisioning the founder runtimes (units, workspaces).
- Populating the identity vault.
- Enabling reseeding or reproduction.
- Provider integration and real payments.
