# 15 — Economic Implementation (PART 17)

Source state: branch `fleet-development`, HEAD `efad214`, schema v8. The economic schema is v5
(`src/fleet/postgres/migrations-phase5.ts:887-1209`), with guards amended in v6, v7 and v8.

This section reports **only what code and schema exist**. Design documents are cited only to mark
drift or to mark something as **NOT IMPLEMENTED**. Every claim cites `path:line`.

## 0. Classification legend

| Class | Meaning |
|---|---|
| IMPLEMENTED AND ACTIVE | Code exists, has an entry point in the deployed build (CLI command or controller route), and does what it says when called. |
| IMPLEMENTED BUT INERT | Code exists and is callable, but a gate (flag, missing signer, status) ensures it never has an external effect, or it has no entry point outside tests. |
| SCHEMA/PLACEHOLDER ONLY | A table, column, enum value or interface exists with no code that uses it meaningfully. |
| DOCUMENTED DESIGN ONLY | Described in docs; no code or schema. |
| NOT PRESENT | Neither code, schema nor design text. |

"Moves real funds" means: signs or broadcasts a blockchain transaction, pays an x402 invoice, or
calls the Conway credits-transfer API.

---

## 1. Summary

| # | Capability | Class | Evidence | Gate flags | Can any code path move real funds? | Reached by |
|---|---|---|---|---|---|---|
| 1 | Treasury (fleet bank ledger, position) | IMPLEMENTED AND ACTIVE (bookkeeping only) | `fleet_treasury_ledger` (`migrations-phase5.ts:1050-1066`); `treasuryPosition` (`src/fleet/treasury/store.ts:404-423`); `treasuryBalanceCents` (`src/fleet/treasury/engine.ts:548-552`) | none needed (records only) | No | CLI `fleet:admin treasury-record`, `treasury-position`, `treasury-policy` |
| 2 | Allocations (capital requests and decisions) | IMPLEMENTED AND ACTIVE (records only) | `fleet_capital_allocations` (`migrations-phase5.ts:965-988`), guard (`:991-1023`); store (`store.ts:192-315`) | none | No | Agent: `POST /v1/capital/propose`. Operator: CLI `capital-list`, `capital-approve`, `capital-reject`, `capital-change`, `capital-complete` |
| 3 | Agent wallets | IMPLEMENTED AND ACTIVE (agent side, upstream code); custody record IMPLEMENTED AND ACTIVE (records only) | Key generation `src/identity/wallet.ts:127-137`; `fleet_wallet_custody` (`migrations-phase5.ts:178-190`) | `REAL_PAYMENTS_ENABLED` gates only `fund_child` and `transfer_credits` to fleet members (`src/fleet/policy.ts:166-191`) | **Yes**: the agent's own tools (§12) | Agent tools `transfer_credits`, `topup_credits`, `x402_fetch`, `fund_child`, `register_domain` |
| 4 | Revenue | IMPLEMENTED AND ACTIVE (manual ledger entry only) | `fleet_agent_ledger.kind='revenue'` (`migrations-phase5.ts:924-940`); `summarizeLedger` (`engine.ts:167-186`) | none | No | CLI `ledger <agentId> revenue <cents>` only; no automatic ingestion |
| 5 | Expenses (direct costs; treasury operating spend) | IMPLEMENTED AND ACTIVE (manual) | `kind='direct_cost'`; treasury kinds `infrastructure`, `inference`, `maintenance`, `compliance` (`engine.ts:538`) | none | No | CLI `ledger`, `treasury-record` |
| 6 | Profit | IMPLEMENTED AND ACTIVE (computed) | `NET_PROFIT = revenue − direct_cost` (`engine.ts:176`) | none | No | CLI `sweep-plan`, `profile`, `rescue-advice` |
| 7 | Sweep / contribution | IMPLEMENTED BUT INERT (planned, never executed) | `computeAgentWaterfall` (`engine.ts:431-484`); `planSweep` (`store.ts:521-534`); `fleet_sweep_plans.status` CHECK `IN ('planned_not_executed')` (`migrations-phase5.ts:1085`) | `OWNER_SWEEP_ENABLED` is **not read** by any sweep code (§13) | No: no executor exists for sweeps | CLI `sweep-plan`, `sweep-reduce` |
| 8 | Custody (freeze, limits, spend requests, transfers) | IMPLEMENTED AND ACTIVE (decisions recorded); execution INERT | `api_request_spend` (`migrations-phase5.ts:1164-1203`); `freezeSpending` (`store.ts:335-349`); `fleet_custody_transfers.status` CHECK `IN ('blocked_payments_disabled')` (`migrations-phase5.ts:1117`) | `REAL_PAYMENTS_ENABLED` (in `executeApprovedSpend`) | No | Agent: `POST /v1/wallet/spend-request`. CLI `spending-freeze`, `spending-unfreeze`, `spending-limit`, `custody-transfer` |
| 9 | Capital requests | IMPLEMENTED AND ACTIVE | `api_propose_allocation` (`migrations-phase5.ts:1137-1158`); route `server.ts:757-774`; client `client.ts:297-300` | none | No | `POST /v1/capital/propose` (session, `full` scope, agent `active`) |
| 10 | Protected obligations | IMPLEMENTED AND ACTIVE (add only) | `fleet_obligations` (`migrations-phase5.ts:952-962`); `addObligation` (`store.ts:177-188`); `operatingObligationsCents` (`engine.ts:208-210`) | none | No | CLI `obligation`. Settle or cancel: **no code path** (§8) |
| 11 | Loans | NOT PRESENT | No table, type, function or doc text (`grep -i loan` over `src/`, `FLEET.md`, `docs/*.md`, `docs/design/*.md`: no hits) | — | — | — |
| 12 | Owner funding | IMPLEMENTED AND ACTIVE (manual ledger entry; excluded from profit) | Agent ledger `owner_funding`; treasury `owner_funding_in` (`migrations-phase5.ts:927`, `:1052`) | none | No | CLI `ledger <agentId> owner_funding <cents>`, `treasury-record owner_funding_in <cents>` |
| 13 | Owner distributions | IMPLEMENTED BUT INERT (planned, never executed) | `planOwnerDistribution` (`engine.ts:580-604`, `store.ts:426-462`); `fleet_owner_distributions.status` CHECK `IN ('rejected','planned_not_executed')` (`migrations-phase5.ts:1100`) | `OWNER_SWEEP_ENABLED` not read by this code; no executor | No | CLI `owner-distribute <cents>` |
| 14 | Double-entry ledger | NOT PRESENT | Two independent single-entry ledgers (`fleet_agent_ledger`, `fleet_treasury_ledger`); no accounts, no balancing constraint, no journal. Design docs defer an "authoritative ledger model" to Phase E (`docs/design/phase-b-operator-api.md:468`, `:1202`) | — | — | — |
| 15 | Payment executor | IMPLEMENTED BUT INERT | `executeApprovedSpend` (`src/fleet/treasury/custody.ts:30-39`), exported (`src/fleet/index.ts:40`); called by **no** production code, only tests (`src/__tests__/fleet/fleet-phase5.test.ts:331-333`) | `REAL_PAYMENTS_ENABLED` must be `"true"` **and** a signer must be passed | No (no caller, no signer) | nothing |
| 16 | Signer (controller custody signer) | SCHEMA/PLACEHOLDER ONLY | Interface `ControllerSigner` (`custody.ts:23-26`); enum value `custody_mode = 'controller_signer'` (`migrations-phase5.ts:182`), never written by any code | — | No | nothing |
| 17 | Investment assets | NOT PRESENT (Phase E "assets" named in design only) | No table or code. `docs/design/phase-b-operator-api.md:1202` lists "accounts, assets" as a future Phase E topic | — | — | — |
| 18 | Estate handling (dead agent's funds) | IMPLEMENTED BUT INERT (plan record only) | `planCustodyTransfer` with `policy='death_recovery'` (`store.ts:359-377`); status fixed to `blocked_payments_disabled` | no flag; blocked by schema | No | CLI `custody-transfer <from> <treasury\|agentId> <cents> death_recovery <reason>` |
| 19 | FleetAdmin override | IMPLEMENTED BUT INERT via CLI (see DRIFT D1) | `approveAllocation(... override, baseDiscretionaryCents)` (`store.ts:218-243`); the CLI passes `override` but never `baseDiscretionaryCents` (`src/fleet/treasury/cli.ts:88-98`) | none | No | CLI `capital-approve … --override` (flag has no effect) |
| 20 | Business takeover | NOT PRESENT | No table, route, function or doc text | — | — | — |

**Answer to "can any code path move real funds?"** No fleet treasury or custody code can: there
is no signer implementation, `executeApprovedSpend` has no caller, and the three plan tables admit
only non-executed statuses. The **agent runtime** (upstream Conway Automaton code) can move real
funds from its own wallet and Conway credit balance, subject to agent-local policy rules; fleet
flags gate only part of that (§12).

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
The repository expects production to hold zero agents (so zero ledger, allocation, custody and spend
rows), `REAL_PAYMENTS_ENABLED=false` and `OWNER_SWEEP_ENABLED=false` in `runtime.env`, and the
`fleet_treasury_policy` row at its migration defaults unless the operator changed it.

---

## 2. Code and data map

### 2.1 Modules

| File | Role | I/O |
|---|---|---|
| `src/fleet/treasury/engine.ts` | Pure arithmetic: waterfall, sweep rate, profile, rescue advice, treasury balance, reserve target, owner-distribution plan | none (`engine.ts:1-24`) |
| `src/fleet/treasury/store.ts` | `PgTreasuryStore`: operator operations over the v5 tables | PostgreSQL, **admin (owner) credential**, pool max 3, `lock_timeout=5000`, `statement_timeout=15000`, `application_name=automaton-fleet-treasury` (`store.ts:72-89`) |
| `src/fleet/treasury/cli.ts` | 20 `fleet:admin` subcommands | dispatches to the store (`cli.ts:29-34`) |
| `src/fleet/treasury/custody.ts` | `SpendDecision`, `ControllerSigner`, `executeApprovedSpend` | none |
| `src/fleet/postgres/migrations-phase5.ts` | v5 SQL (`V5_SQL`) and the v4 custody and spend-request tables | — |
| `src/fleet/service/server.ts` | Agent routes `POST /v1/capital/propose`, `POST /v1/wallet/spend-request` | agent role → `api_*` |

The store is instantiated only in `src/fleet/postgres/cli.ts:329-343`. Its connection string is
`FLEET_ADMIN_DATABASE_URL || FLEET_CONTROLLER_DATABASE_URL || DATABASE_URL`. The actor string is
`operator:<OS username>` (`cli.ts:312`). The fleet service never loads `PgTreasuryStore`.

### 2.2 Privilege boundary

| Role | Treasury table privilege | Economic functions |
|---|---|---|
| Owner (admin CLI) | all (schema owner) | all |
| Service role | none of the v5 tables; `SELECT` on `fleet_wallet_custody` only (`src/fleet/postgres/migrations.ts:1145-1157`) | none |
| Agent role | none | `api_propose_allocation`, `api_request_spend` (`migrations.ts:1169-1170`) |
| Operator API role (v8) | none | none; `ops.read.treasury` is reserved and not allowed by the v8 CHECK (`docs/design/phase-b-operator-api.md:468`) |
| PUBLIC | `REVOKE ALL` (`migrations-phase5.ts:1206-1208`) | none |

### 2.3 v5 tables (all amounts `bigint` cents)

| Table | Key columns and constraints | Mutability | Source |
|---|---|---|---|
| `fleet_treasury_policy` | single row `id=1`; defaults below; `mature_fleet_rate <= max_sweep_rate`; treasury ≠ owner address (case-insensitive) | UPDATE allowed; DELETE blocked | `migrations-phase5.ts:889-910` |
| `fleet_agent_ledger` | `kind IN ('revenue','direct_cost','owner_funding','fleet_funding','allocation_deployed','allocation_returned','sweep_to_treasury')`; `amount_cents > 0`; `source IN ('controller','operator','agent_reported')`; `reference` ≤ 200 | append-only (UPDATE/DELETE trigger) | `:924-940` |
| `fleet_balance_observations` | `cash_cents >= 0`; `source` as above | no immutability trigger | `:942-950` |
| `fleet_obligations` | ULID id; description 1..300; `amount_cents > 0`; `status IN ('approved','settled','cancelled')` default `approved`; `approved_by NOT NULL` | no immutability trigger | `:952-962` |
| `fleet_capital_allocations` | see §7 | guarded transitions; DELETE blocked | `:965-1024` |
| `fleet_sweep_reductions` | `reduction_pct` in (0, 1]; reason 1..500; `expires_at > starts_at`; at most `starts_at + 180 days`; approver guard on INSERT/UPDATE | no DELETE block | `:1026-1047` |
| `fleet_treasury_ledger` | 12 kinds; `amount_cents > 0`; `status IN ('recorded','planned_not_executed')` | append-only | `:1050-1066` |
| `fleet_treasury_obligations` | ULID; free-text `category`; `status` as obligations | no immutability trigger | `:1068-1077` |
| `fleet_sweep_plans` | `rate BETWEEN 0 AND 0.70`; `amount_cents >= 0`; `waterfall jsonb`; `status IN ('planned_not_executed')` | append-only | `:1079-1090` |
| `fleet_owner_distributions` | `requested_cents > 0`; `status IN ('rejected','planned_not_executed')`; CHECK `approved_cents <= GREATEST(balance − reserve − obligations, 0)` when planned | append-only | `:1092-1107` |
| `fleet_custody_transfers` | `destination IN ('fleet_treasury','agent')`; `policy IN ('quarantine_recovery','death_recovery','rebalance','sweep')`; `status IN ('blocked_payments_disabled')`; `to_agent_id` set iff destination `agent`, and ≠ `from_agent_id`; approver guard | append-only | `:1109-1132` |
| `fleet_wallet_custody` (v4) | `custody_mode IN ('controller_supervised','controller_signer')` default supervised; `spending_frozen`; `daily_limit_cents >= 0` default 0; `supervisor` default `fleetadmin`; unique `lower(wallet_address)` | UPDATE allowed | `:178-190` |
| `fleet_spend_requests` (v4) | ULID; `amount_cents > 0`; `decision IN ('denied','approved_not_executed')` | append-only | `:866-879` |

"Append-only" means a `BEFORE UPDATE OR DELETE` trigger calling `fleet_history_immutable()`.

### 2.4 Approver rule (current: v8)

Every decision table calls `fleet_require_operator_approver` (`migrations-phase8.ts:313-326`, which
replaces `migrations-phase5.ts:912-922`):

```sql
CREATE OR REPLACE FUNCTION fleet_require_operator_approver(p_approver text, p_subject text) RETURNS void LANGUAGE plpgsql
SET search_path = @@SCHEMA@@, pg_temp AS $$
BEGIN
  IF p_approver IS NULL OR length(trim(p_approver)) = 0 THEN
    RAISE EXCEPTION 'FLEET_APPROVAL_REQUIRED: an operator approver is required';
  END IF;
  IF p_approver = p_subject OR EXISTS (SELECT 1 FROM fleet_agents WHERE agent_id = p_approver OR lower(wallet_address) = lower(p_approver)) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: agents cannot approve capital exceptions (approver %)', p_approver;
  END IF;
  IF p_approver ~* '^op[:_]' OR EXISTS (SELECT 1 FROM fleet_operator_principals WHERE principal_id = p_approver OR name = p_approver) THEN
    RAISE EXCEPTION 'FLEET_SELF_APPROVAL: operator API principals can never approve (approver %)', p_approver;
  END IF;
END $$;
```

Called from:
- `fleet_allocations_guard` on any status or term change (`migrations-phase5.ts:1015-1018`);
- `fleet_sweep_reductions_guard` (`:1040-1047`);
- `fleet_custody_transfers_guard` (`:1123-1130`);
- `addObligation` (`store.ts:180`);
- `planOwnerDistribution` (`store.ts:441`).

**Not** called by: `recordAgentLedger`, `recordBalance`, `recordTreasury`, `addTreasuryObligation`,
`setPolicy`, `freezeSpending`, `setDailySpendLimit`, `planSweep`. Those rely only on the caller
holding the owner credential.

---

## 3. Treasury policy

Defaults in the database (`migrations-phase5.ts:889-906`) and in TypeScript (`engine.ts:50-67`):

| Field | DB column | Default | DB range | TS validation (`validatePolicy`, `engine.ts:79-97`) |
|---|---|---|---|---|
| runwayDays | `runway_days` | 30 | 0..365 | ≥ 0 |
| contingencyPct | `contingency_pct` | 0.10 | 0..1 | 0..1 |
| minContingencyCents | `min_contingency_cents` | 1000 | ≥ 0 | ≥ 0 |
| populationRates | `population_rates` jsonb | `[{10,0.10},{20,0.125},{30,0.15},{40,0.175},{49,0.20}]` | none | bands strictly increasing, each `maxAgents` < 50, rate 0..maxSweepRate |
| matureFleetRate | `mature_fleet_rate` | 0.45 | 0..0.70, ≤ max | 0..maxSweepRate |
| maxSweepRate | `max_sweep_rate` | 0.70 | 0..0.70 | 0..`HARD_MAX_SWEEP_RATE` (0.7, `engine.ts:26`) |
| reserveTargetMonths | `reserve_target_months` | 3 | 0..36 | ≥ 0 |
| maturityAgeDays | `maturity_age_days` | 180 | 1..3650 | ≥ 1 |
| treasuryAddress | `treasury_address` | NULL | `^(0x[0-9a-fA-F]{40}\|[1-9A-HJ-NP-Za-km-z]{32,44})$` | — |
| ownerWithdrawalAddress | `owner_withdrawal_address` | NULL | same regex; ≠ treasury (lowercased) | — |

`SWEEP_TUNING` constants (code only, not configurable, `engine.ts:70-77`): `surplusSaturation = 4`,
`treasuryNeedWeight = 0.05`, `lossWeight = 0.05`, `productiveDiscountWeight = 0.1`,
`targetRoi = 0.5`.

CLI: `fleet:admin treasury-policy` with no arguments prints the row. With `key=value` pairs it
patches `runwayDays`, `contingencyPct`, `minContingencyCents`, `matureFleetRate`, `maxSweepRate`,
`reserveTargetMonths`, `maturityAgeDays`, `treasuryAddress` and `ownerWithdrawalAddress` (an empty
value becomes NULL) (`cli.ts:56-67`). `populationRates` **cannot** be set from the CLI. `setPolicy`
validates, updates, and writes event `treasury_policy_set` (`store.ts:137-155`).

---

## 4. The sweep formula exactly as implemented

Entry points: `PgTreasuryStore.agentWaterfall` (`store.ts:484-518`) gathers inputs;
`computeAgentWaterfall` (`engine.ts:431-484`) computes them; `planSweep` (`store.ts:521-534`)
records the result.

### 4.1 Inputs gathered from the database (`store.ts:484-518`)

| Input | Query |
|---|---|
| agent | `SELECT created_at, status FROM fleet_agents WHERE agent_id = $1` (unknown → error) |
| cash | `cashCents` argument if given, else the latest `fleet_balance_observations.cash_cents` for the agent (none → error `no observed balance`) |
| policy | `fleet_treasury_policy` row 1 |
| treasury position | §9.2 (balance and reserve target) |
| living agents | `fleet_state.living_agents` |
| ledger | all `fleet_agent_ledger` rows of the agent, ordered by `occurred_at` |
| obligations | all `fleet_obligations` rows of the agent (`amount_cents`, `due_at`, `status`) |
| allocations | all `fleet_capital_allocations` rows of the agent |
| reductions | all `fleet_sweep_reductions` rows of the agent |
| asOf | `new Date()` (JS clock of the CLI host) |
| lookbackDays | 30 (the default; `agentWaterfall` never passes another value) |

`planSweep` additionally requires the agent's status to be exactly `active`
(`store.ts:522-523`).

### 4.2 Units and types

- All money is integer **cents** in `bigint` columns, converted with `Number(...)` in TypeScript
  (`store.ts:56-64`, `store.ts:415`). Values above 2^53 cents lose precision; the code has no guard.
- Rates are JS doubles. Every rate component is rounded to 6 decimal places with
  `Math.round(x * 1e6) / 1e6` (`engine.ts:376`).
- Time: `DAY_MS = 86 400 000` (`engine.ts:27`); ages are fractional days.

### 4.3 Step by step (`engine.ts:431-484`)

```ts
validatePolicy(policy);
const asOf = input.asOf ?? new Date();
const cash = Math.max(0, Math.floor(input.cashCents));
const lookback = input.lookbackDays ?? 30;
const burn = dailyBurnCents(input.ledger, asOf, lookback, input.agentCreatedAt);
const all = summarizeLedger(input.ledger, { to: asOf.getTime() });
const obligations = operatingObligationsCents(input.obligations);
const runway = policy.runwayDays * burn;
const growth = approvedGrowthCapitalCents(input.allocations, asOf);
const contingency = Math.max(policy.minContingencyCents, Math.ceil(policy.contingencyPct * 30 * burn));
const protectedTotal = obligations + runway + growth + contingency;
const excess = Math.max(0, cash - protectedTotal);
…
const sweepBase = Math.min(excess, all.undistributedProfitCents);
const sweep = Math.floor(sweepBase * rate.rate);
if (cash - sweep < Math.min(cash, protectedTotal)) {
  throw new Error("treasury invariant violated: sweep would reach protected capital");
}
```

| Quantity | Exact definition | Rounding | Source |
|---|---|---|---|
| CASH_ON_HAND | `max(0, floor(cashCents))` | floor | `engine.ts:434` |
| Ledger sums | Sum of `amountCents` per kind over entries with `amountCents > 0` and `occurredAt <= asOf`. Kinds summed: `revenue`, `direct_cost`, `owner_funding`, `fleet_funding`, `sweep_to_treasury`. `allocation_deployed` and `allocation_returned` are **ignored** by the sums | exact integers | `engine.ts:167-186` |
| GROSS_REVENUE | Σ revenue | — | `engine.ts:178` |
| DIRECT_COSTS | Σ direct_cost | — | `engine.ts:179` |
| NET_PROFIT | `GROSS_REVENUE − DIRECT_COSTS` (may be negative). Owner and fleet funding excluded by construction | — | `engine.ts:176` |
| UNDISTRIBUTED_PROFIT | `max(0, NET_PROFIT − Σ sweep_to_treasury)`, cumulative over the agent's whole history | — | `engine.ts:184` |
| daily burn | `ceil(Σ direct_cost in [asOf − 30 d, asOf] / days)` where `days = max(1, min(30, ageDays))` and `ageDays = (asOf − createdAt) / DAY_MS` (fractional) | ceil | `engine.ts:189-195` |
| OPERATING_OBLIGATIONS | Σ `max(0, amountCents)` over obligations with `status === 'approved'`. `dueAt` is **ignored**: past-due and far-future obligations both count | — | `engine.ts:208-210` |
| PROTECTED_RUNWAY | `runwayDays × burn` | integer × integer | `engine.ts:439` |
| APPROVED_GROWTH_CAPITAL | Σ `max(0, (approvedAmountCents ?? 0) − deployedCents)` over allocations where `status === 'approved'` and `startDate <= asOf < expiryDate` | — | `engine.ts:197-206` |
| CONTINGENCY_RESERVE | `max(minContingencyCents, ceil(contingencyPct × 30 × burn))` | ceil | `engine.ts:441` |
| protectedTotal | obligations + runway + growth + contingency | — | `engine.ts:442` |
| EXCESS_CAPITAL | `max(0, cash − protectedTotal)` | — | `engine.ts:443` |
| SWEEP_BASE | `min(EXCESS_CAPITAL, UNDISTRIBUTED_PROFIT)` | — | `engine.ts:457` |
| FLEET_SWEEP | `floor(SWEEP_BASE × rate.rate)` where `rate.rate` is already rounded to 6 decimals | floor of an IEEE-754 product | `engine.ts:458` |
| AGENT_RETAINED_CAPITAL | `cash − FLEET_SWEEP` | — | `engine.ts:478` |
| Invariant | throws if `cash − sweep < min(cash, protectedTotal)` | — | `engine.ts:459-461` |
| `runwayDays` (output field) | `burn > 0 ? floor(cash / burn) : Infinity` (days of cash at current burn; unrelated to the policy field of the same name) | floor | `engine.ts:480` |

Why the invariant always holds: `sweep ≤ sweepBase ≤ excess = cash − protectedTotal` when
`cash > protectedTotal`, and `sweep = 0` otherwise, because `rate ≤ 0.7 < 1`.

**Floating-point note (as implemented):** because the rate is a double, `floor` can under-sweep by
one cent. For example, `Math.floor(100 * 0.29)` is `28` (the product is `28.999999999999996`).
The error always favours the agent (the safe direction).

### 4.4 Dynamic rate (`engine.ts:315-389`)

```ts
export function computeSweepRate(input: SweepRateInput, policy: TreasuryPolicy = DEFAULT_TREASURY_POLICY): SweepRateBreakdown {
  const max = Math.min(policy.maxSweepRate, HARD_MAX_SWEEP_RATE);
  const base = Math.min(populationBaseRate(input.livingAgents, policy), max);
  const maturity = clamp01(input.agentAgeDays / policy.maturityAgeDays) * (0.5 + 0.5 * clamp01(input.profile.revenueConsistency));
  const surplusIntensity =
    input.protectedCents > 0
      ? clamp01((input.excessCents / input.protectedCents - 1) / (SWEEP_TUNING.surplusSaturation - 1))
      : input.excessCents > 0 ? 1 : 0;
  const surplusUplift = (max - base) * maturity * surplusIntensity;
  const shortfall = input.treasury.reserveTargetCents > 0 ? clamp01(1 - input.treasury.balanceCents / input.treasury.reserveTargetCents) : 0;
  const treasuryUplift = SWEEP_TUNING.treasuryNeedWeight * shortfall;
  const lossUplift = SWEEP_TUNING.lossWeight * clamp01(input.profile.recentLossRatio);
  const roiScore = input.profile.roi === null ? 0 : clamp01(input.profile.roi / SWEEP_TUNING.targetRoi);
  const productiveDiscount = SWEEP_TUNING.productiveDiscountWeight * roiScore * clamp01(input.profile.forecastAccuracy ?? 0);
  const policyRate = Math.min(max, base + Math.max(0, surplusUplift + treasuryUplift + lossUplift - productiveDiscount));
  const reduction = clamp01(input.reduction);
  const round = (x: number) => Math.round(x * 1e6) / 1e6;
  return { base: round(base), …, policyRate: round(policyRate), reduction: round(reduction), rate: round(policyRate * (1 - reduction)) };
}
```

| Term | Definition |
|---|---|
| `clamp01(x)` | `min(1, max(0, x))`; any non-finite x becomes 0 (`engine.ts:151`) |
| base | `populationBaseRate(livingAgents)`: if `livingAgents >= 50`, `matureFleetRate`; else the first band with `livingAgents <= maxAgents`; else the last band's rate. Defaults: 0–10 → 0.10, 11–20 → 0.125, 21–30 → 0.15, 31–40 → 0.175, 41–49 → 0.20, ≥ 50 → 0.45 (`engine.ts:315-319`). `livingAgents` is `fleet_state.living_agents` (reserved and quarantined slots excluded) |
| maturity | `clamp01(ageDays / 180) × (0.5 + 0.5 × clamp01(revenueConsistency))` |
| surplusIntensity | `clamp01((excess / protected − 1) / 3)`. 0 at excess ≤ protected, 1 at excess ≥ 4 × protected. With protected = 0: 1 if excess > 0, else 0 |
| surplusUplift | `(max − base) × maturity × surplusIntensity` |
| treasuryUplift | `0.05 × clamp01(1 − treasuryBalance / reserveTarget)`; 0 when reserveTarget = 0 |
| lossUplift | `0.05 × clamp01(recentLossRatio)` |
| productiveDiscount | `0.1 × clamp01(roi / 0.5) × clamp01(forecastAccuracy ?? 0)`; 0 when roi is null |
| policyRate | `min(max, base + max(0, surplusUplift + treasuryUplift + lossUplift − productiveDiscount))`. The discount can cancel uplifts but never push the rate below base |
| reduction | `activeReduction = 1 − Π(1 − clamp01(pct))` over reductions not revoked with `startsAt <= asOf < expiresAt` (`engine.ts:213-220`) |
| rate | `round6(policyRate × (1 − reduction))`, so the range is [0, 0.7] |

`agentAgeDays = (asOf − createdAt) / DAY_MS`; `excessCents` and `protectedCents` are the waterfall
values; `treasury` comes from §9.2 (`engine.ts:445-456`).

### 4.5 Capital performance profile (`engine.ts:224-311`)

"Closed" allocation: `status === 'completed'`, or `status === 'expired'` with `deployedCents > 0`
(`engine.ts:245-247`). Closed allocations are sorted by `decidedAt ?? expiryDate`.

| Field | Definition |
|---|---|
| capitalDeployedCents | Σ `deployedCents` over closed |
| capitalReturnedCents | Σ `actualReturnCents ?? 0` over closed |
| roi | `(returned − deployed) / deployed`, or null if deployed = 0 |
| forecastAccuracy | mean over closed with `expectedReturnCents > 0` of `clamp01(1 − |actual − expected| / expected)`, or null |
| failedAllocations / profitableAllocations | closed with actual < deployed / actual > deployed |
| consecutiveFailures | trailing run (newest first) of closed allocations with actual < deployed |
| revenueConsistency | Six 30-day buckets ending at asOf, asOf − 30 d, … (each `[to − 30 d, to]`, inclusive both ends). `clamp01(1 − populationStdDev / mean)`; 0 if mean = 0 |
| recentLossRatio | over closed with `decidedAt ?? expiryDate >= asOf − 90 d`: `clamp01(Σ max(0, deployed − actual) / Σ deployed)`; 0 if none |
| capitalEfficiency | 90-day `NET_PROFIT` / Σ ledger `allocation_deployed` in the last 90 days; null if 0 |
| discretionaryMultiplier | `round3(min(2, max(0, 1 + roiScore × (forecastAccuracy ?? 0.5) − 0.25 × consecutiveFailures − 0.5 × recentLossRatio)))`, where `roiScore = roi === null ? 0 : clamp01(roi / 0.5)` |
| rescuesLast180d | allocations of kind `rescue`, status not `proposed` or `rejected`, with `decidedAt ?? startDate >= asOf − 180 d` |

`discretionaryLimitCents(base, profile) = floor(base × multiplier)` (`engine.ts:489-491`).

`evaluateRescue` (`engine.ts:501-508`) returns `recommended = true` only when none of these holds:
`consecutiveFailures >= 3`; `rescuesLast180d >= 2`; `roi < −0.5`; waterfall `runwayDays > 14`.
`requiresOperatorApproval` is always `true`. It is advice; nothing acts on it.

### 4.6 Worked example (computed with the repository's `computeAgentWaterfall`)

Inputs: `asOf = 2026-09-25T00:00Z`; agent created 200 days earlier; cash 60 000; 1 living agent;
treasury balance 0 and reserve target 0; default policy.

- Ledger: revenue 50 000 (10 days ago); direct cost 7 000 (100 days ago); direct cost 3 000 (5 days
  ago); owner funding 20 000 (150 days ago).
- One approved obligation: 5 000.
- One current growth allocation: approved 10 000, deployed 4 000.

| Step | Value |
|---|---|
| GROSS_REVENUE / DIRECT_COSTS / NET_PROFIT | 50 000 / 10 000 / 40 000 |
| OWNER_FUNDING (excluded from profit) | 20 000 |
| daily burn | ceil(3 000 / 30) = 100 |
| OPERATING_OBLIGATIONS | 5 000 |
| PROTECTED_RUNWAY | 30 × 100 = 3 000 |
| APPROVED_GROWTH_CAPITAL | 10 000 − 4 000 = 6 000 |
| CONTINGENCY_RESERVE | max(1 000, ceil(0.1 × 30 × 100) = 300) = 1 000 |
| protected total | 15 000 |
| EXCESS_CAPITAL | 60 000 − 15 000 = 45 000 |
| UNDISTRIBUTED_PROFIT | 40 000 |
| SWEEP_BASE | min(45 000, 40 000) = 40 000 |
| rate: base / maturity / surplusIntensity / surplusUplift | 0.1 / 0.5 (age ≥ 180; revenue consistency 0 because all revenue is in one bucket) / 0.666667 / 0.2 |
| rate: treasury / loss / productive | 0 / 0 / 0 |
| policyRate = rate | 0.3 |
| FLEET_SWEEP | floor(40 000 × 0.3) = 12 000 |
| AGENT_RETAINED_CAPITAL | 48 000 |
| runwayDays (output) | floor(60 000 / 100) = 600 |

### 4.7 What happens to a computed sweep

`planSweep` inserts one `fleet_sweep_plans` row (`rate`, `amount_cents = FLEET_SWEEP`, full waterfall
JSON, `computed_by`, status `planned_not_executed`) and one event `sweep_planned` with
`executed: false` (`store.ts:526-532`). Nothing else happens:

- no agent-ledger `sweep_to_treasury` entry;
- no treasury-ledger `sweep_in` entry;
- no custody transfer;
- no signer call.

`UNDISTRIBUTED_PROFIT` falls only when an operator records `ledger <agentId> sweep_to_treasury
<cents>` by hand.

### 4.8 Temporary sweep reductions

- CLI: `sweep-reduce <agentId> <pct 0..1> <days> <reason…>` → `reduceSweep` (`cli.ts:118-126`,
  `store.ts:319-333`).
- `starts_at` defaults to `now()`; `expires_at = now + days`; the database caps the span at 180 days
  and requires pct in (0, 1].
- The approver guard runs; event `sweep_reduced`.
- **Revocation:** `revoked_at` exists and the engine honours it (`engine.ts:216`), but no code sets it
  (SCHEMA/PLACEHOLDER ONLY).

---

## 5. Revenue, expenses, profit

| Item | How it enters | Class |
|---|---|---|
| Agent revenue | `fleet:admin ledger <agentId> revenue <cents> [reference]` → `recordAgentLedger` with `source='operator'` (`cli.ts:73-75`, `store.ts:159-168`) | IMPLEMENTED AND ACTIVE (manual) |
| Agent direct cost | `ledger <agentId> direct_cost <cents>` | IMPLEMENTED AND ACTIVE (manual) |
| `source = 'controller'` / `'agent_reported'` | Allowed by CHECK; **no code writes them** (the CLI always writes `operator`; there is no agent API for ledger entries) | SCHEMA/PLACEHOLDER ONLY |
| Automatic ingestion of agent income or spend | The agent's local SQLite `transactions` table (upstream, e.g. `insertTransaction` in `src/agent/tools.ts:338`, `:1042`, `:1791`) is **never** synced to `fleet_agent_ledger` | NOT PRESENT |
| Cash on hand | `fleet:admin balance <agentId> <cents>` → `fleet_balance_observations` with `source='operator'` (`cli.ts:76-78`), or the `cashCents` argument of `sweep-plan` | IMPLEMENTED AND ACTIVE (manual) |
| `fleet_funding` | Summed (`engine.ts:168`), reported nowhere in the waterfall output | IMPLEMENTED (bookkeeping) |
| `allocation_deployed` / `allocation_returned` | Written by `recordDeployment` and `completeAllocation`; used only by `capitalEfficiency` (deployed kind) | see §7 |
| Profit | `NET_PROFIT` computed per request, not stored except inside `fleet_sweep_plans.waterfall` | IMPLEMENTED AND ACTIVE (computed) |

No input validation exists on `kind` in TypeScript; the database CHECK rejects unknown kinds.
Amounts must match `^\d+$` (`cli.ts:38-41`) and be > 0 (DB CHECK).

---

## 6. Owner funding

- Agent-level: ledger kind `owner_funding`. It is excluded from `NET_PROFIT`, so it can never be part
  of `SWEEP_BASE` as profit (`engine.ts:158-176`). It does count in cash on hand when an operator
  records a balance, so it can raise `EXCESS_CAPITAL`, but the sweep is capped by
  `UNDISTRIBUTED_PROFIT`.
- Treasury-level: kind `owner_funding_in`, counted as an inflow in the treasury balance
  (`engine.ts:526`, `engine.ts:548-552`).
- Neither moves money; both are records typed by the operator.

---

## 7. Capital allocations and capital requests

### 7.1 State machine (`fleet_allocations_guard`, `migrations-phase5.ts:991-1023`)

```
INSERT ─► proposed ─┬─► approved ─┬─► completed
                    ├─► rejected  ├─► expired
                    └─► cancelled └─► cancelled
```

- INSERT must be `proposed`.
- `allocation_id`, `agent_id`, `proposed_by`, `requested_amount_cents` and `created_at` are
  immutable.
- Terminal states (`rejected`, `completed`, `expired`, `cancelled`) are immutable.
- Any change of status, `approved_amount_cents`, `start_date` or `expiry_date` requires
  `fleet_require_operator_approver(NEW.decided_by, NEW.agent_id)`.
- DELETE is blocked.
- CHECK: `approved` requires `approved_amount_cents`, `start_date` and `expiry_date > start_date`;
  `approved_amount_cents <= requested_amount_cents × 10` (`migrations-phase5.ts:986-987`).
- v6 and v7 insert guard: dry-run agents and agents with scope ≠ `full` cannot hold allocations
  (`migrations-phase7.ts:78-91`).
- **`cancelled`:** allowed by the guard, but no code path sets it (SCHEMA/PLACEHOLDER ONLY).

### 7.2 Agent side: capital request (IMPLEMENTED AND ACTIVE)

Route `POST /v1/capital/propose` (`server.ts:757-774`). It requires a signed session and `full`
scope. Body: `requestedCents` (safe integer > 0), `expectedReturnCents` (safe integer ≥ 0, default
0), `expectedDurationDays` (safe integer), `purpose` (1..500). The service generates the allocation
ULID. SQL (`migrations-phase5.ts:1137-1158`):

- `fleet_authenticate(…, 'propose_allocation')`;
- the agent must be `active` (else `FLEET_AGENT_UNHEALTHY`);
- at most 5 `proposed` allocations per agent (else `FLEET_TOO_MANY_PROPOSALS`);
- `purpose` passes through `fleet_scrub` and is truncated to 500;
- `expected_duration_days` must be 1..3650 (table CHECK);
- event `capital_requested`.

Client helper: `FleetApiClient.proposeCapital` (`client.ts:297-300`). No agent tool in
`src/agent/tools.ts` calls it (`grep proposeCapital` has no match outside the client), so a running
agent's model cannot reach it through the standard tool set.

### 7.3 Operator side

| CLI | Store method | Notes |
|---|---|---|
| `capital-list [agentId]` | `listAllocations` | ordered by `created_at` |
| `capital-approve <id> <cents> <days> <reason…> [--override]` | `approveAllocation` | start = now; expiry = now + days × 86 400 000 ms; see DRIFT D1 |
| `capital-reject <id> <reason…>` | `rejectAllocation` | |
| `capital-change <id> [cents=N] [expiryDays=N] <reason…>` | `changeAllocation` | only while `approved` |
| `capital-complete <id> <actualReturnCents>` | `completeAllocation` | writes ledger `allocation_returned` if > 0 |
| (none) | `proposeAllocation` (operator-initiated, e.g. rescue) | no CLI; programmatic only |
| (none) | `recordDeployment` | no CLI; programmatic only. Guard: `deployed + amount <= approved` |
| (none) | `expireAllocations` | no CLI and no scheduler. Expiry still stops protection in the engine (`isAllocationCurrent`) |

Because `recordDeployment` has no entry point, `deployed_cents` stays 0 in practice. An approved,
current allocation therefore protects its **full** approved amount until expiry.

---

## 8. Protected obligations

- Agent obligations: `obligation <agentId> <cents> <dueInDays> <description…>` → `addObligation`
  (`cli.ts:79-85`, `store.ts:177-188`). The approver guard runs; event `obligation_approved`.
- They count as protected capital while `status = 'approved'`, whatever `due_at` is
  (`engine.ts:208-210`).
- Treasury obligations: `addTreasuryObligation` (`store.ts:395-402`), **no CLI**; they reduce the
  owner-distribution surplus (§9.3).
- **Settle and cancel:** the `settled` and `cancelled` statuses exist, but no code sets them
  (SCHEMA/PLACEHOLDER ONLY). An obligation stays protected forever unless the owner edits the row
  in SQL.

The protected-capital components implemented are exactly obligations, runway, current approved
growth, and contingency (§4.3). No other category exists in code.

---

## 9. Treasury (fleet bank) and owner distributions

### 9.1 Ledger

- Kinds (`engine.ts:512-524`, DB CHECK `migrations-phase5.ts:1052-1055`):
  - inflows: `sweep_in`, `owner_funding_in`, `allocation_return_in`;
  - uses: `infrastructure`, `inference`, `maintenance`, `emergency_rescue`, `replacement_agent`,
    `approved_growth`, `compliance`, `contingency`;
  - plus `owner_distribution`.
- `recordTreasury` (`store.ts:381-393`, CLI `treasury-record <kind> <cents> [agentId]`) accepts
  inflows and uses. It refuses `owner_distribution`, and always writes `status='recorded'`.
- `planOwnerDistribution` writes the only `planned_not_executed` rows (kind `owner_distribution`).

### 9.2 Position (`store.ts:404-423`)

| Quantity | Definition | Rounding |
|---|---|---|
| balance | Σ over `status='recorded'`: +amount for inflows, −amount for every other kind (`engine.ts:548-552`). Planned rows do not count | exact |
| monthly operating expense | override if given; else `ceil(Σ recorded amounts of kinds infrastructure, inference, maintenance, compliance with occurred_at in [asOf − 90 d, asOf] × 30 / 90)` (`engine.ts:555-562`) | ceil |
| reserve target | `ceil(monthly × reserveTargetMonths)` (`engine.ts:564-566`) | ceil |
| obligations | Σ `fleet_treasury_obligations.amount_cents` where `status='approved'` | exact |
| surplus | `max(0, balance − reserve target − obligations)` | exact |

With no recorded operating spend, the reserve target is 0, so the sweep-rate treasury uplift is 0
and the whole balance above obligations counts as surplus.

### 9.3 Owner distributions (IMPLEMENTED BUT INERT)

CLI `owner-distribute <cents>` → `store.planOwnerDistribution` (`store.ts:426-462`):

1. Refuse if `owner_withdrawal_address` is not set.
2. Refuse if it equals `treasury_address` (case-insensitive). The DB CHECK enforces the same.
3. Compute the position; `planOwnerDistribution` (`engine.ts:580-604`):
   `surplus = max(0, balance − reserve − obligations)`;
   `approved = min(max(0, floor(requested)), surplus)`. If `approved <= 0` the status is `rejected`,
   else `planned_not_executed`, and the reason says "partially approved" when approved < requested.
4. In one transaction: approver guard; insert into `fleet_owner_distributions` (destination = the
   owner address); when planned, one treasury-ledger row `owner_distribution` with status
   `planned_not_executed`; event `owner_distribution_planned` or `owner_distribution_rejected` with
   `executed: false`.
5. The DB CHECK enforces `approved_cents <= GREATEST(balance − reserve − obligations, 0)` when
   planned (`migrations-phase5.ts:1104`).

No code reads `fleet_owner_distributions` to pay anything. `OWNER_SWEEP_ENABLED` is not consulted.

---

## 10. Custody, spend requests, payment executor, signer

### 10.1 Custody record

- One row per agent wallet. It is created by `fleet_agents_custody_on_insert` (roots) and by
  `fleet_agents_lifecycle_effects` on `provisioning → active` (children), with
  `ON CONFLICT DO NOTHING` (`migrations-phase5.ts:278-315`).
- Leaving the living population freezes it (`migrations-phase5.ts:256-260`).
- Dry-run and restricted-scope agents are forced frozen with limit 0 on every INSERT or UPDATE
  (`migrations-phase7.ts:60-76`).

Operator controls:
- `spending-freeze <agentId> <reason…>` and `spending-unfreeze <agentId> <reason…>`. Unfreeze is
  refused unless the agent is `active` or `unresponsive` (`store.ts:335-349`).
- `spending-limit <agentId> <cents>` (`store.ts:351-356`).

### 10.2 Spend request (IMPLEMENTED AND ACTIVE as a decision; never executed)

Route `POST /v1/wallet/spend-request` (`server.ts:776-794`). Body: `fromWallet` (≤64), `toAddress`
(≤64), `amountCents` (safe integer > 0), `purpose` (≤300), `allocationId?` (≤26). Decision SQL
(`migrations-phase5.ts:1164-1203`), in order:

| Step | Rule | Result |
|---|---|---|
| 1 | `fleet_authenticate(…, 'request_spend')` | error code |
| 2 | amount > 0 and `toAddress ~ '^(0x[0-9a-fA-F]{40}\|[1-9A-HJ-NP-Za-km-z]{32,44})$'` | `FLEET_BAD_REQUEST` |
| 3 | A custody row exists and `lower(fromWallet) = lower(custody.wallet_address)` | `FLEET_NOT_AUTHORIZED` (not recorded as a request) |
| 4 | `v_today` = Σ approved requests of this agent in the last 24 h | — |
| 5 | Agent status ≠ `active` | `denied` ("agent not healthy") |
| 6 | Custody `spending_frozen` | `denied` |
| 7a | With `allocationId`: it must exist, be the caller's, be `approved`, and `now()` must be `BETWEEN start_date AND expiry_date` | `denied` |
| 7b | With `allocationId`: `deployed_cents + amount > approved_amount_cents` | `denied` |
| 7c | Without `allocationId`: `v_today + amount > daily_limit_cents` | `denied` |
| 8 | Insert into `fleet_spend_requests` (purpose scrubbed, ≤300); event `spend_denied` or `spend_approved_not_executed` | returns `{ok, decision, reason, executed: false}` |

The service always returns `executed: false` (`server.ts:792-793`). The client helper `FleetApiClient.requestSpend` (`client.ts:302-305`) is called by no agent tool, so the standard tool set never reaches this route.

Observations (as implemented):
- `daily_limit_cents` defaults to 0, so every request without an allocation is denied until an
  operator raises the limit.
- An allocation-based approval does **not** increment `deployed_cents` and is not counted against
  the daily limit, so repeated requests against one allocation are each approved while
  `deployed_cents` (which stays 0) plus the single amount fits. No money moves, so this has no
  external effect today; it would matter once an executor exists.
- The allocation window uses `BETWEEN` (inclusive expiry); the engine's `isAllocationCurrent` uses
  `< expiry` (exclusive).

### 10.3 Payment executor (IMPLEMENTED BUT INERT)

`src/fleet/treasury/custody.ts:30-39`:

```ts
export async function executeApprovedSpend(
  decision: SpendDecision,
  env: Record<string, string | undefined>,
  signer: ControllerSigner | null,
): Promise<ExecutionResult> {
  if (decision.decision !== "approved_not_executed") return { executed: false, reason: "request was denied" };
  if (env.REAL_PAYMENTS_ENABLED?.trim().toLowerCase() !== "true") return { executed: false, reason: "REAL_PAYMENTS_ENABLED=false" };
  if (!signer) return { executed: false, reason: "no controller custody signer is configured" };
  return { executed: true, txHash: (await signer.send(decision)).txHash };
}
```

- Callers: only `src/__tests__/fleet/fleet-phase5.test.ts:331-333`. It is exported from
  `src/fleet/index.ts:40`, but no route, CLI command or service loop calls it.
- It does not read `fleet_spend_requests`; a caller would have to build the `SpendDecision` itself.

### 10.4 Signer (SCHEMA/PLACEHOLDER ONLY)

- `interface ControllerSigner { send(req: SpendDecision): Promise<{ txHash: string }> }`
  (`custody.ts:23-26`). No class implements it.
- `custody_mode = 'controller_signer'` is allowed by CHECK; nothing writes it.
- `fleet:doctor` lists the missing signer as a blocker for "SAFE FOR REAL PAYMENTS"
  (`src/fleet/doctor.ts:449-451`, `doctor.ts:549-554`).
- CLAUDE.md forbids creating a controller signer without explicit request and review.

### 10.5 Custody transfers and estate handling (IMPLEMENTED BUT INERT)

CLI `custody-transfer <fromAgentId> <treasury|agentId> <cents> <policy> <reason…>` →
`planCustodyTransfer` (`cli.ts:136-152`, `store.ts:359-377`):

- policy `rebalance` requires an `active` source agent;
- insert with status `blocked_payments_disabled` (the only allowed value) and approver guard;
- event `custody_transfer_planned` with `executed: false`.

Policies `quarantine_recovery` and `death_recovery` are the only "estate" mechanism: a recorded
intent with no executor. There is no inheritance rule, no automatic plan on death, and no link from
`fleet_mark_dead` or the lifecycle trigger to custody transfers.

---

## 11. FleetAdmin override

- The only override in code is `approveAllocation`'s `override` flag. It bypasses the
  discretionary-limit check, which runs only when `baseDiscretionaryCents` is supplied
  (`store.ts:227-233`).
- Everything else an admin can do comes from holding the owner credential (direct SQL). Triggers
  still apply to the owner: immutability, the approver rule, and status CHECKs.
- There is no break-glass command, no dual control, and no override audit beyond the `override`
  field in the `capital_approved` event (`store.ts:241`).

---

## 12. Code outside `src/fleet` that can move real funds

These are upstream Conway Automaton tools in the agent runtime. They sign or pay with the agent's own
key (`~/.automaton/wallet.json`, `src/identity/wallet.ts:48`, `:127-137`) or its Conway API key.

| Tool | Effect | Agent-local limits (`src/agent/policy-rules/financial.ts`, defaults `src/types.ts:585-596`) | Fleet gate (`src/fleet/policy.ts`) |
|---|---|---|---|
| `transfer_credits` | Conway credits transfer (`tools.ts:1010-1052`) | max single 5 000 c; hourly 10 000 c; daily 25 000 c; per turn 2; minimum reserve 1 000 c; confirmation above 1 000 c; plus a tool guard of ≤ half the balance | Denied in EMERGENCY; denied to a fleet-member address unless `REAL_PAYMENTS_ENABLED` (`policy.ts:179-191`) |
| `fund_child` | Credits transfer to a local child (`tools.ts:1734-1826`) | minimum reserve; ≤ half the balance | Denied in EMERGENCY, in DEVELOPMENT, and whenever `REAL_PAYMENTS_ENABLED` is false (`policy.ts:166-173`) |
| `x402_fetch` | Signs an x402 USDC payment with the agent's account (`tools.ts:2763-2836`) | max 100 c per payment; domain allow-list `conway.tech`; minimum reserve | Denied in EMERGENCY only |
| `topup_credits` | Pays USDC on Base via x402 for credits; tiers $5–$2 500 (`tools.ts:288-347`) | none of the financial rules apply by name | **Not** in `EMERGENCY_BLOCKED_TOOLS`; no fleet gate |
| `register_domain` | Conway domain purchase paid in USDC via x402 (`tools.ts:2247-2272`) | — | Denied in EMERGENCY only |

Consequences:

- `REAL_PAYMENTS_ENABLED=false` does **not** stop an agent from spending its own funds on
  non-fleet recipients. FLEET.md records this as a residual risk (`FLEET.md:170`, `FLEET.md:350`).
- None of these flows touches the fleet treasury, custody or ledger tables.
- The shipped agent unit is "NOT enabled by setup" (`deploy/systemd/automaton-agent.service:2`).

<!-- PRODUCTION: to be filled from 14-PRODUCTION-SNAPSHOT.md -->
Operator facts as of 2026-09-25: zero agents are enrolled, so no agent runtime holds funds under
fleet control.

Name collision: the upstream per-agent `TreasuryPolicy` / `DEFAULT_TREASURY_POLICY` in
`src/types.ts:585-596` (transfer caps) is unrelated to the fleet `TreasuryPolicy` /
`DEFAULT_TREASURY_POLICY` in `src/fleet/treasury/engine.ts:37-67` (sweep policy).

---

## 13. Flag usage, exhaustive

`REAL_PAYMENTS_ENABLED` (parsed "true", case-insensitive, else false; `src/fleet/config.ts:36-39`,
`:71`):

| Read site | Effect |
|---|---|
| `src/fleet/policy.ts:170`, `:180` | `fund_child` denial; `transfer_credits` to fleet members |
| `src/fleet/treasury/custody.ts:36` | executor refusal (inert, no caller) |
| `src/index.ts:372` | log line only |
| `src/fleet/doctor.ts:220`, `:224`, `:528` | checklist item "payments disabled" |
| `src/fleet/operator/main.ts:117` | reported read-only to Operator API clients |
| `src/fleet/dry-run/child.ts:38`, `root-witness.ts:57`, `dry-run/operator.ts:87` | refuse to run when true |
| `command-safety.ts` pattern #44 | agent shell may not set it |

`OWNER_SWEEP_ENABLED`:

| Read site | Effect |
|---|---|
| `src/index.ts:374-376` | if true: logs "OWNER_SWEEP_ENABLED is set but owner sweeps are not implemented; ignoring." |
| `src/fleet/doctor.ts:221`, `:225`, `:529`, `:554` | checklist; readiness blocker when true |
| `src/fleet/operator/main.ts:118` | reported read-only |
| dry-run child and witness | refuse to run when true |
| `src/fleet/secrets.ts:45` | allow-listed (not treated as a secret) |

No sweep, distribution or custody code reads `OWNER_SWEEP_ENABLED`. **Owner sweeps: NOT
IMPLEMENTED** (the code says so at `src/index.ts:375`).

---

## 14. Tests covering economics (not run for this document)

`src/__tests__/fleet/fleet-phase5.test.ts`:
- pure engine tests at lines 112-341 (sweep rate, the waterfall never sweeping protected capital
  including a randomized invariant at 247, owner funding, profile, rescue, distributions, executor
  refusal);
- database tests at lines 819-930 (proposal and no self-approval, admin controls recorded not
  executed, spend-request isolation, treasury separation, sweep plans, discretionary limit with
  override at 930).

The discretionary-limit test goes through `approveAllocation` with `baseDiscretionaryCents`, not
through the CLI (see D1).

---

## 15. DRIFT items

- **D1 (discretionary override):** FLEET.md (Phase 5, Capital allocations) says "Approvals above the
  performance-scaled discretionary limit need an explicit override." In code the limit is checked
  only when `baseDiscretionaryCents` is passed (`store.ts:227-233`). The only operator entry point,
  CLI `capital-approve`, never passes it (`cli.ts:92-96`), so CLI approvals are never limited and
  `--override` has no effect. The only hard DB bound is `approved <= requested × 10`.
- **D2 (runway definition):** FLEET.md defines PROTECTED_RUNWAY as runway days × "average daily
  direct-cost burn (30-day lookback)". Code divides by `min(30, max(1, age))` days and rounds up
  (`engine.ts:189-195`). For agents younger than 30 days the divisor is the age, not 30. This is
  consistent with the code comment but not stated in FLEET.md.
- **D3 (obligations):** FLEET.md says OPERATING_OBLIGATIONS are "Approved, unsettled obligations".
  Code has no path to settle or cancel an obligation (§8), and `due_at` is ignored.
- **D4 (custody freeze):** FLEET.md says revocation "freezes wallet spending". The freeze affects only
  `api_request_spend` decisions; the agent's own key and Conway credits are not frozen (§12; also
  05-AGENT-SECURITY.md §15).
- **D5 (CLI header):** `src/fleet/treasury/cli.ts:19` documents `spending-limit`, `custody-transfer`
  and the others, but lists no command for deployments, expiry or treasury obligations. The store
  methods `recordDeployment`, `expireAllocations`, `addTreasuryObligation` and `proposeAllocation`
  have no CLI (§7.3, §8). FLEET.md does not claim they do; this is recorded so a rebuilder does not
  assume an entry point.
- **D6 (sweep accounting loop):** FLEET.md's waterfall says the sweep base uses "undistributed NET
  PROFIT". The code never records a planned sweep as distributed (§4.7). Planning twice without a
  manual `sweep_to_treasury` entry yields the same sweep again.

## 16. NOT IMPLEMENTED / NOT PRESENT

- Loans, investment assets, business takeover: NOT PRESENT.
- Double-entry ledger: NOT PRESENT. Phase E "authoritative ledger model, accounts, assets" is
  DOCUMENTED DESIGN ONLY (`docs/design/phase-b-operator-api.md:468`, `:1202`).
- Controller custody signer and controller-held agent keys: NOT IMPLEMENTED (interface only).
- Execution of sweeps, owner distributions, custody transfers and approved spends: NOT IMPLEMENTED
  (plan rows only; statuses constrained to non-executed values).
- Owner sweeps (`OWNER_SWEEP_ENABLED`): NOT IMPLEMENTED (`src/index.ts:375`).
- Automatic revenue, cost or balance ingestion from agents or chain: NOT PRESENT.
- Treasury reads through the Operator API (`ops.read.treasury`): DOCUMENTED DESIGN ONLY, reserved
  and refused by the v8 CHECK.
- Settling or cancelling obligations; revoking sweep reductions; cancelling allocations: SCHEMA ONLY.
