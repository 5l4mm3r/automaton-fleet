# F2 — Autonomous economy: removing the owner from operations (design review, 2026-10-01)

Status: **DESIGN REVIEW. Phase A implemented on a development branch (schema v26, charter v3; §20); nothing
deployed.** Phases B–H are not started. The four engineering safety flags stay false while the machinery is proved.
They are engineering flags, not the intended operating model.

## 0. The correction

The doctrine is that agents are autonomous economic actors and FleetController is their bank. The owner maintains
infrastructure and software, tops up the treasury and provider access while needed, and sets constitutional policy. The
owner does **not** decide niches, products, channels, experiments, pivots, routine spending or capital allocation, and
the fleet must keep working while the owner is absent.

**Evidence that we drifted.** Founder 1 has £91.88 cash, £8.12 spent (all inference) and £0 revenue. It has slept since
2026-09-30 waiting for an owner decision about Gumroad. That is not a model failure: the system taught it to wait.

## 1–3. Owner-gate audit

54 database functions require an owner actor. Most guard inward assets correctly. The table lists every gate that
touches an agent's work, plus the inward ones for completeness.

| # | Barrier (where) | Why it exists | Class |
|---|---|---|---|
| 1 | **Spend > £100/order or > £50/day → `awaiting_owner`** (`api_spend_request`, `fleet_economic_model.owner_approval_threshold_cents` 10000 / `agent_daily_spend_cents` 5000, `ledger-spend-decision`) | Early custody caution: a flat cap with the owner above it | **MOVE TO FLEETCONTROLLER**: spend inside an approved envelope is reserved automatically; a constitutional ceiling (a % of treasury) remains as an absolute stop, not an approval queue |
| 2 | **Every payee is an owner-enrolled destination**, with a 3-day cooldown (`fleet_destination_enroll/activate`; 0 destinations exist today, so *no* spend of any size is possible) | Anti-exfiltration: agents never name addresses | **MOVE**: a controller-managed vendor registry with automated verification (category, domain, limits, risk-based cooldown). Owner and treasury withdrawal destinations stay an **EXCEPTION** |
| 3 | **Capital to an agent** (`fleet_admin_agent_capital` grant/principal; `api_propose_allocation` / `fleet_allocations_guard`) | Bootstrap-era manual funding | **MOVE**: capital requests → automated decision → envelope. The owner funds the **treasury**, not agents |
| 4 | **Experiment decisions the policy leaves to the owner**: E4 and irreversible (`fleet_experiment_evaluate` → `FLEET_OWNER_DECISION_REQUIRED`, `experiment-decide`) | Caution for high stakes | **MOVE**: irreversible and high-evidence cases go to stricter risk bands, never to the owner |
| 5 | **Owner-run experiment signals**: `experiment-observe` (owner as "synthetic executor"), `experiment-attribute-revenue`, `experiment-relevance` overrides | Signals need a trusted recorder | **MOVE**: the controller records signals from integrations and the ledger; attribution follows from envelope/venture ids on journals. An owner override stays as an audited correction, never required |
| 6 | **Sweep reductions** (`fleet_sweep_reductions_guard`) | Treasury protection | **MOVE**: automatic reductions for high-ROI requests inside the risk engine |
| 7 | **Owner requests (R28)**: "blocking" flag, stale resurfacing, "keep waiting" option, doctor WARN | My F1-LIVE-01 design | **REMOVE as a blocking construct.** Keep only as action-scoped **EXCEPTION dependency records** (§6) |
| 8 | **Knowledge promotion** (`fleet_knowledge_review`) | Curated institutional memory | **MOVE**: automated promotion on verified outcomes (ledger-backed results). An owner veto is constitutional and optional. It never blocks an agent |
| 9 | **Identity facts** (`request_identity_fact` → `fleet_org_identity_decide`) | Legal name, registration and bank facts belong to a real person/organisation | **EXCEPTION**: scoped to the one action that needs it |
| 10 | **External accounts needing KYC/signature** (Gumroad and the like) | Human identity | **EXCEPTION** per dependency. The fleet sets up **one** fleet-level merchant/storefront identity (infrastructure, once), so agents need no per-venture KYC (§14) |
| 11 | Per-founder cognition enable/budget (`fleet_founder_cognition_set`), research limits | Cost control | Global switches stay **constitutional**. The per-agent budget **MOVES** to the controller, derived from runway (the agent pays its own inference) |
| 12 | Genesis, reproduction, refounding, replication (`fleet_genesis_*`, reproduction policy) | Population and lineage risk | **Constitutional / FleetController-governed**: reproduction is already rule-based; execution is pinned off as an engineering flag |
| 13 | Runtime approval and upgrades, provider credits, FX, owner funding, subscriptions | Infrastructure | **Owner's normal role** (FX can become an automated feed later) |
| 14 | Custody execution, owner withdrawal, strong-auth threshold, confirmations, agent holds, operator proposals | Treasury, custody and operator safety | **Keep (inward)**. These are the barriers that *should* exist |

**Founder-facing text that teaches dependency** (all REMOVE or REWRITE):
- The charter says "all spending is a structured request that policy **and the owner** decide."
- `request_spend` says "an owner-enrolled destination id … policy/owner approval."
- `request_identity_fact` and `propose_knowledge` say "the owner decides".
- `request_owner_decision` (R28) uses "e.g. enable a sales channel or account" as its example. That is exactly the
  wrong reflex.
- The R28 stale line offers "keep waiting".
- The slim packet ends "… otherwise sleep". Idle backoff to ~33 min makes sleep the attractor.
- Founder 1's own goal g1 reads "… a sales channel **the owner can enable**". It absorbed the doctrine the prompts
  taught.

## 4. Where previous phases added owner dependency

- **Pre-session (v10–v12):** the owner threshold, owner-enrolled destinations and owner capital grants. These were
  sensible for custody bring-up, but nothing replaced them with an automated allocator.
- **R24:** the experiment pipeline routes E4 and irreversible cases to the owner and makes the owner the signal recorder.
- **R28 / F1-LIVE-01 (mine):**
  - a "blocking" owner request tied to a goal, plus a tool that invites channel requests to the owner;
  - doctor framing the owner's queue as the fix;
  - my investigation report naming "owner decision on 62cbe1b7" as the smallest step.

  All of these point the loop at the owner instead of at alternatives. The capability-signature half of F1-LIVE-01 is
  sound and stays.
- **Cognition design:** idle backoff without an exploration trigger. Correct for cost; wrong without a discovery path.

## 5. Corrected architecture

```
OWNER (constitutional plane)        policy versions, infrastructure, software, treasury top-ups, provider access,
   │  no operational queue            one-time fleet-level identities (merchant/storefront KYC). Never per decision.
   ▼
FLEETCONTROLLER (the bank)          risk engine · capital requests → decisions → execution envelopes · vendor registry ·
   │                                 capability broker (scoped credentials) · ledger · treasury sweeps · profit board ·
   │                                 survival accounting · signals/attribution · inward safety barriers
   ▼
AGENTS (autonomous actors)          survive → discover → research → select → build → distribute → market → sell → earn →
                                     pay → retain → contribute → reinvest → expand → repeat; a portfolio of ventures
```

**Invariant.** No agent state may have an owner action as its only exit. A refusal, unavailable dependency or decline
blocks one *action* and always carries an autonomous next step.

## 6. R28 owner requests → dependency records

- **Rename and re-scope:** `fleet_owner_requests` becomes **external dependency records**. Each one references
  **(venture, action)**, not a goal.
  - `blocking` is replaced by `blocks_action`: true means only that action cannot proceed.
  - The kind becomes `human_identity | kyc_account | signature | legal | constitutional`. Ordinary needs (channels,
    spending, experiments, capital) are **not valid kinds**; they go to FleetController or the agent's own work.
- **Packet framing:** "Dependency X (Gumroad listing) is unavailable for action Y. Continue with alternatives."
  - no "STALE" escalation toward the owner;
  - no "keep waiting" option;
  - staleness only stops resurfacing the record, and after N days it auto-expires to `unresolved_expired`.
- **Doctor:** INFO count of open dependencies. WARN only for a *constitutional* item. Never framed as "owner action
  needed for the agent to proceed".
- **Tool:** `request_owner_decision` becomes `record_external_dependency`. Its description says: "record one action
  that needs a human identity, signature or KYC; you keep working on alternatives; nothing waits on it".
- **Gumroad / Founder 1:** `62cbe1b7` becomes a dependency for venture "landlord compliance tracker", action "Gumroad
  listing", with `blocks_action = true`. The goal is not blocked, no owner action is requested, and the record may stay
  open indefinitely without consequence.

## 7. Opportunity engine

- **Trigger:** a wake with no active venture work, no pending envelope step and a **discovery allowance** remaining
  starts a *discovery task* instead of the slim "otherwise sleep" packet.
  - FleetController grants the allowance from runway: e.g. ≤ 2 % of survival equity per day for exploration inference
    and research, and none below a runway floor.
  - Idle backoff applies only when the allowance is spent or runway is low.
- **Pipeline (agent-side, persisted):**
  1. scan: trends, demand signals, marketplaces, forums;
  2. generate several candidates (product, service, tool, content, niche);
  3. evidence per candidate: research artifacts, so the controller verifies provenance and relevance as today;
  4. score with a standard rubric (§10 inputs): demand evidence, competition, price and margin, capability fit, build
     time, time-to-first-revenue, capital needed, **channel availability including no-account channels**, downside;
  5. reject weak candidates (kept with reasons, so the agent never re-explores the same idea blindly);
  6. promote the best to a venture in `DISCOVERED → RESEARCHING`.
- **Non-prescriptive:** the rubric is economic; no business model is prescribed. Fleet knowledge (promoted lessons) is
  advisory input.

## 8. Venture lifecycle

```
DISCOVERED → RESEARCHING → VALIDATING → BUILDING → LAUNCHING → OPERATING → SCALING
                 ↘            ↘            ↘           ↘            ↘           ↘
                                   PIVOTING / PAUSED / FAILED → CLOSED
```

- **Table `fleet_ventures`:** agent, key, thesis, state, candidate score, evidence refs, envelopes, channels,
  dependencies, metrics (revenue, costs, net, ROI), forecast vs actual, timestamps. The transition history is
  append-only.
- **Who moves it:** the agent drives transitions. The controller enforces evidence and envelope conditions (e.g.
  `LAUNCHING` needs a live channel; `SCALING` needs a ledger-backed positive contribution margin).
- **Portfolio:** several ventures per agent, with the concurrency bound derived from runway and capital efficiency, not
  fixed. A successful venture never locks the agent in.
- **Migration:** existing experiments map onto ventures and envelopes (an experiment becomes a `VALIDATING` envelope).

## 9. Automated capital allocation

**`fleet_capital_requests`** holds the fields you listed: agent, venture, amount, purpose, evidence, expected revenue,
expected net profit, ROI, payback, maximum downside, runway impact, stop conditions, milestones, lower-cost alternative
and confidence.

**`fleet_capital_decide(request)`** is deterministic, versioned and explainable:
- **Outcomes:** `APPROVE | PARTIAL_APPROVE | APPROVE_WITH_LIMITS | DEFER | REJECT`, each with machine-readable reasons
  and, for DEFER/REJECT, what would change the answer (more evidence, a smaller tranche, a cheaper alternative).
- **No owner path:** there is no branch that routes to the owner.
- **Re-applying:** the agent may re-apply with changes, rate-limited.

It **generalises** the existing pieces:
- the experiment evaluator (evidence ladder, survival headroom, hard cap);
- the spend policy (per-order and daily limits become envelope parameters).

## 10. Risk engine

**Hard boundaries (constitutional; any failure → REJECT):**
- **Agent:** maximum loss ≤ a fraction of survival equity; never touches protected capital or obligations; runway after
  commitment ≥ the floor.
- **Fleet:** treasury reserve ≥ target months; capital committed fleet-wide ≤ cap; concentration per opportunity class,
  channel or vendor ≤ cap; a per-request absolute ceiling as a % of treasury.
- **Never automated:** illegal, prohibited or reputational-risk categories; custody, crypto or trading while those
  flags are off.

**Scoring bands (economic):**
- **Expected value:** confidence-weighted, discounted by evidence level (verified, not claimed) and by the agent's
  **forecast calibration** (realized vs predicted on past envelopes).
- **Track-record bonus:** realized ROI and capital efficiency, ledger-backed only. Simulated ROI is never used, as
  today.
- **Downside penalty:** reversibility and time-to-feedback; irreversibility tightens the band (smaller tranche, more
  milestones). It never escalates to the owner.

**Mapping to decisions:**

| Score band | Decision |
|---|---|
| Strong | APPROVE |
| Good but large | PARTIAL_APPROVE (first tranche) |
| Uncertain | APPROVE_WITH_LIMITS (tight stop-loss, short expiry) |
| Missing evidence or timing | DEFER |
| Negative EV or a hard-boundary failure | REJECT |

**Policy as data:** thresholds live in a versioned policy row (constitutional). Decisions record the policy version, so
they are auditable and replayable.

## 11. Execution envelope

**Table `fleet_envelopes`:** capital limit, purpose, venture, expiry, maximum loss, maximum single spend, permitted
services (vendor-registry categories or ids), milestones (tranches), stop-loss, reassessment threshold, and counters
(spent, committed, realized revenue).

**Enforcement:**
- `api_spend_request` checks the envelope instead of the owner threshold. Spend inside the envelope is reserved
  automatically; spend outside is refused with a reason ("request more capital"), never `awaiting_owner`.
- Stop-loss reached → *that envelope* freezes automatically; the agent and its other ventures continue.
- A milestone met (controller-verified signal) → the next tranche is released automatically.
- Expiry → unspent capital returns.

## 12. Treasury interaction (the established model, kept)

- Sweeps apply to **realized net profit** only. Rates are FleetController's (population rates 10–20 %, mature 45 %,
  maximum 70 % already in `fleet_treasury_policy`). Young or vulnerable agents keep more (maturity, runway).
- **Automatic temporary reductions** for approved high-ROI requests are recorded on the envelope (row 6). Agents never
  set their own rate.
- **Capital flows:**
  - the treasury funds envelopes;
  - envelope losses are bounded by the maximum loss;
  - returns and sweeps flow back.
- **The owner's role:** funds or tops up the treasury, which is one ledger action, not an approval of agent decisions.
  Owner withdrawal stays an inward exception.

## 13. Profit board (ledger-backed only)

**Per agent:**
- lifetime revenue, lifetime net profit, recurring net profit (30 days), ROI on deployed capital, capital efficiency;
- runway (days), treasury contribution, forecast accuracy (calibration);
- ventures: succeeded, failed, active.

**Ranking:** primarily recurring net profit and realized ROI, with runway as the survival gate.

**Excluded:** vanity metrics (tool calls, pages fetched, ideas generated).

**Who reads it:** the risk engine (track record) and the reproduction policy (already rule-based on these metrics).

## 14. Credential isolation

- **Capability broker in FleetController:** agents act through controller-mediated tools, e.g. `publish_listing`,
  `create_payment_link`, `send_outreach`, `call_service`.
  - The tools use **scoped, per-agent or per-venture service identities** held in the controller vault.
  - Each identity is spend-limited, rate-limited and revocable, and every call is audited.
  - Agents never see a secret, as they already never see the database or provider keys.
- **Fleet-level identities, set up once by the owner (infrastructure):**
  - a merchant/payment processor account with per-agent sub-accounts or payment links;
  - a self-hosted storefront domain;
  - developer accounts on marketplaces that allow API selling.

  After that, agents need **no** per-venture human action.
- **Remaining dependencies:** an action that still needs a new human KYC or signature becomes an action-scoped
  dependency record (§6). The agent routes around it.

## 15. Survival and death loop

**Runway** = survival equity ÷ trailing burn (inference + subscriptions + infrastructure allocation + committed
envelope spend).

| Runway band | Behaviour |
|---|---|
| > 60 days | Explore and build; normal discovery allowance |
| 30–60 days | Focus: fewer parallel ventures; discovery allowance halved |
| 14–30 days | Cut weak envelopes (auto stop-loss tightening); fastest-revenue ventures only; cheaper cognition budget (the per-agent budget falls with runway; routing stays task-based) |
| < 14 days | Revenue-only mode: no new envelopes except fast-payback; liquidate or abandon poor ventures |

**Death:** at `survivalEquityExhausted` the agent dies under the established lifecycle rules (estate, settlement). No
owner rescue path, though the owner may fund the *treasury*.

## 16. Expansion of a profitable agent

- The opportunity engine keeps scoring new candidates.
- For each surplus decision the agent compares the marginal expected ROI of scaling an existing venture against a new
  venture, and submits a capital request for the better option. The controller decides on EV and concentration.
- A second business is just another venture.
- New *agents* (replication) remain constitutional, governed by the reproduction policy and its flags.

## 17. Keeping the owner from becoming a bottleneck

- **Structural:**
  - no agent-facing function returns `awaiting_owner` or a similar state for ordinary work;
  - the dependency-kind CHECK forbids ordinary categories;
  - every refusal code carries a next autonomous step.
- **Tests:**
  - the autonomy simulation asserts **zero** owner approvals for normal operation;
  - a 30-day owner-absence simulation;
  - a lint test that founder-facing text contains no "the owner decides" outside the constitutional list.
- **Operations:**
  - doctor metric "operational owner dependencies = 0" (WARN if > 0);
  - "agent idle with discovery allowance unused for > N wakes" WARN, which would have caught Founder 1 days ago.

## 18. Migration implications

- **Schema v26+:**
  - ventures, capital requests, envelopes and the vendor registry;
  - owner requests become dependency records (kind / `blocks_action` / venture-action; existing rows migrated; the
    Gumroad row becomes a venture-scoped dependency);
  - the economic model gains envelope-based spend and an owner threshold reinterpreted as a constitutional ceiling;
  - experiments map onto ventures and envelopes, with data kept.
- **Charter v3 and tool text rewrite:** the prefix changes, a one-time cache miss. The capability signature already
  gives founders one full "what changed" packet.
- **Founder 1:** a runtime upgrade. Its g1 becomes a venture; its state is preserved (identity, ledger, facts).
- **Real money stays off.** Every new spend path runs in simulated mode until the constitutional flags are deliberately
  enabled. CLAUDE.md's economic invariants are preserved: sweeps on net profit, protected capital, agents never approve
  their own requests, FleetController decides.

## 19. Implementation phases (each gated by tests; none deployed without approval)

| Phase | Content | Fixes |
|---|---|---|
| **A. Doctrine and loop** (small, first) | Charter v3 and tool text; R28 → dependency records (non-blocking); slim packet → discovery trigger with a controller-granted discovery allowance; Gumroad re-scoped | Founder 1's indefinite sleep |
| **B. Ventures and opportunity engine** | `fleet_ventures`, discovery pipeline, rubric, rejected-candidate memory | Autonomous work creation |
| **C. Bank** | Capital requests, risk engine, envelopes (simulated money); replaces the experiment owner branches and the spend owner threshold | Owner-free capital |
| **D. Distribution** | Vendor registry and capability broker; simulated channels plus a controller-hosted storefront route; the owner's one-time fleet-level identities (infrastructure) | Agents can sell without per-venture KYC |
| **E. Economics** | Profit board, forecast calibration, sweep integration, automatic reductions | Rank and allocate by real performance |
| **F. Survival** | Runway bands driving discovery allowance, envelopes and cognition budget; death-loop integration | Rational behaviour under scarcity |
| **G. Proof** | The Phase-13 deterministic end-to-end autonomy simulation (all listed scenarios), the zero-owner-approval invariant and the 30-day owner-absence test | Gate before any production rollout |
| **H. Later, constitutional** | Enabling real payments, custody, sweeps and replication under FleetController governance | — |

## 20. Phase A implementation record (2026-10-01; branch only, not deployed, not merged)

**Scope delivered:**
- charter v3;
- tool and packet text;
- R28 owner requests → action-scoped dependency records (schema v26);
- the discovery trigger with a controller-computed allowance;
- Gumroad re-scoped.

Nothing touches money, custody, payments, replication, sweeps, the cap, the mode or the runtime pins.

**Registry (schema v26, `migrations-phase26.ts`):**
- **Table kept, records re-scoped.** `fleet_owner_requests` stays in place for compatibility and is not renamed.
  - `blocking` → `blocks_action`.
  - New columns `kind` and `action` (the one unavailable action).
  - Valid kinds: `human_identity`, `kyc`, `legal_signature`, `constitutional_change`, `non_delegable_credential`.
  - Any other kind → `FLEET_NOT_AN_EXCEPTION`, with a reason telling the founder the decision is its own (or
    FleetController's).
  - CHECK `fleet_owner_requests_open_is_exception`: an open record is always an exceptional kind that blocks exactly
    its action. The privilege audit enforces it, together with the guard trigger and the allowed writers.
- **Data migration:**
  - Founder 1's `62cbe1b7` becomes `kyc`, action "List the landlord compliance tracker on Gumroad …", still pending
    and undecided.
  - Other open rows of an ordinary category are `retired` by `migration`, with a response saying nothing waits on
    them.
  - `account_or_identity` → `kyc`; `policy_exception` → `constitutional_change`.
  - Decided history keeps its outcome (kind `legacy_ordinary`).
- **No staleness.** The API reports `blocking:false` / `stale:false`, so an R28 runtime never escalates. The founder's
  wake signal is the record's status only, not its age.
  - Deviation from §6: there is no auto-expiry. An open record has no consequence, the founder can withdraw it, and at
    most 5 can be open.
- **Doctor.** "external dependencies" is information. It WARNs only while a `constitutional_change` is open.
  "institutional knowledge" no longer WARNs on age.
- **Discovery allowance** (`fleet_discovery_policy`, `fleet_discovery_allowance`, reported in cognition status).
  Defaults:
  - budget/day = min(300p, survival equity × 2 %);
  - runway = equity ÷ (7-day inference burn ÷ 7);
  - allowed only when enabled, equity > 0, runway ≥ 14 days (or no burn yet), and today's *total* inference < budget.
  - A missing policy row fails closed. The row cannot be deleted, and no function may write it.
  - Changing it is a constitutional act (owner, SQL). A setter is a follow-up.

**Founder runtime:**
- **Charter v3** (3 950 chars): an autonomous economic actor; FleetController is the bank; the owner is not consulted
  on ordinary business; a blocked dependency blocks one action; "never idle by default".
  - `FOUNDER_CHARTER_V2` and `FOUNDER_ROUTED_ADDENDUM_R23` are frozen byte-for-byte for the sealed evaluations. Both
    pre-registration hashes reproduce.
- **Tools.** `request_owner_decision` / `withdraw_owner_request` → `record_external_dependency` /
  `withdraw_external_dependency`. Both are still `planning`, and the manifest digest is unchanged.
  - The `request_spend`, `propose_knowledge` and `request_identity_fact` descriptions no longer say "the owner
    decides".
- **Discovery trigger.** An idle wake (nothing changed since a sleep-only turn) with `discovery.allowed` gets a full
  *discovery* packet instead of the slim one: research demand, no-account routes, other products or ventures.
  - Without an allowance (spent, runway floor, or an older controller) it falls back to the slim packet, which now ends
    "you may sleep until your discovery allowance renews".
  - The existing idle backoff still bounds calls.
- **Capability-change detection (R28) is preserved.** An R28 → F2-A upgrade yields one full packet naming the renamed
  tools.
- **Fixed in passing:**
  - a resolved dependency's answer was hidden when the record had been open for more than 7 days (`ageS` is the age
    *at* resolution);
  - a malformed list entry dropped every dependency from the packet.

**Proof that owner absence cannot freeze a founder:**
- Founder side (`fleet-f2a-autonomy.test.ts`): 30 simulated days with zero owner actions and Gumroad unresolved
  throughout. Every day has at least one discovery packet, no packet points at the owner, and spend stays inside the
  allowance.
- Registry side (`fleet-f2a-pg.test.ts`): no function outside the dependency family reads `fleet_owner_requests`, so an
  open record cannot gate spend, experiments, capabilities, cognition or lifecycle.
- The remaining owner-only exits are constitutional kill switches: cognition disabled or paused.

**Not in Phase A** (later phases, unchanged):
- the spend owner threshold and enrolled destinations (C/D);
- experiment E4/irreversible owner branches (C);
- ventures, capital requests, envelopes, vendor registry, profit board and runway bands (B–F).

