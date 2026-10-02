# F2 — Autonomous economy: removing the owner from operations (design review, 2026-10-01)

Status: **CANDIDATE BUILT AND TESTED ON THE DEVELOPMENT VM (branch `f2/autonomous-economy`; schemas v26–v30, charter
v4; §20, §24, §25); nothing deployed, nothing merged.** Phases A–G are implemented as a candidate; phase H (real money,
custody, sweeps to the owner, replication) is not. The four engineering safety flags stay false. They are engineering
flags, not the intended operating model. Production activation is a separate, approved procedure (§29).

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
| 1 | **Spend > £100/order or > £50/day → `awaiting_owner`** (`api_spend_request`, `fleet_economic_model.owner_approval_threshold_cents` 10000 / `agent_daily_spend_cents` 5000, `ledger-spend-decision`) | Early custody caution: a flat cap with the owner above it | **RETIRED at schema v27 (§24)**: own capital is the founder's to risk-manage; FleetController checks custody only — no fixed amount, no owner queue. Any emergency stop is a relative, contextual infrastructure circuit breaker |
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

## 7. Opportunity engine: decision-driven research (corrected 2026-10-01)

**Research is not browsing.** It exists for two reasons only:
1. to **find** a viable niche, business model, product, service or gap in existing businesses that agents can bridge;
2. to **expand** an existing viable or profitable venture.

Everything else is noise. The loop is TARGET → EVIDENCE → DECISION → EXECUTION → SALES → LEARNING → NEXT DECISION,
never SEARCH → SEARCH → SEARCH. The first draft of this section granted a daily "discovery allowance" (≤ 2 % of survival
equity) and shut discovery off below a 14-day runway floor. Both are **withdrawn**: an entitlement invites spending for
its own sake, and a controller-imposed runway floor takes survival strategy away from the agent.

**Trigger: an unresolved economic decision, never a budget.** Before spending meaningful cognition on research the agent
has:
- a concrete decision ("Is there enough demand for X at £29 to launch it?", "Which of these three validated products has
  the best demand-to-competition ratio?", "Would expanding venture A onto marketplace B improve profit?");
- a hypothesis;
- an identified evidence gap: the ONE missing fact;
- the expected information value: how the answer could change the decision;
- a stop condition, its own.

"Search for interesting trends", "browse social media for ideas" and "use today's allowance" are not decisions.

**Information-value stop.** Research stops when more information is unlikely to change the decision. The agent asks "do
I know enough to make the next economically meaningful move?":
- if yes: decide and execute;
- if no: obtain the single highest-value missing fact.

**Idle is not browse.**
- An agent with an open decision is pushed to decide it.
- An agent with an execution path (open goals) is pushed to execute it. A dependency blocks only its own action.
- An agent with neither runs ONE concise opportunity-identification cycle:
  1. **Targeted search** for economic evidence: sales velocity, marketplace rankings and bestseller lists, search
     demand, price, competition, customer pain, recurring demand, margins, fulfilment complexity, startup capital, time
     to first sale, channel availability and evidence of actual purchasing. A viral topic without purchase intent is
     weak evidence.
  2. **Rank** a short shortlist (≤ 5) by expected economic value: likely demand, competition, margin, capital, time to
     launch and revenue, confidence, downside, evidence quality, ability to execute.
  3. **Select** the strongest. The agent decides; no owner approval, and FleetController does not choose the business.
  4. **Execute** the production stage the venture type needs:
     - physical goods: source → prototype → produce → list → market → sell;
     - digital product: build → package → publish → market → sell;
     - software: build → deploy → acquire users → monetise;
     - service: operationalise → list/outreach → deliver → collect.
  5. **Measure**: sales, conversion, revenue, margin, acquisition cost, refunds, customer response, operating cost,
     actual versus forecast.
  6. **Learn**: every outcome updates the agent's knowledge, so the next decision is better and nothing is rediscovered.
  7. **Iterate, scale or pivot**: scale what the evidence proves; modify what weakens; stop or pivot quickly when the
     economics fail, regardless of sunk work.
- **Non-prescriptive:** no business model and no permanent scoring weights are prescribed (§21, §22).

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

> **Scope (resolved 2026-10-01, §23): Fleet / treasury / shared capital only.** These are FleetController's decisions as a
> lender and custodian. The agent's own spendable capital is self-risk-managed by the agent and never passes through
> `fleet_capital_decide`.

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

> **Scope (resolved 2026-10-01, §23):** the risk engine assesses requests for Fleet / treasury / shared capital, where
> FleetController is exposed. It never rates, ranks or selects the agent's opportunities, and it never applies to the
> agent's own spendable capital.

**Hard boundaries (constitutional; any failure → REJECT):**
- **Agent, as a borrower of Fleet capital:**
  - the request never touches protected capital or obligations;
  - FleetController may weigh the agent's loss capacity, runway and liquidity as the lender.

  No such floor applies to the agent's own capital.
- **Fleet:** treasury reserve ≥ target months; capital committed fleet-wide ≤ cap; concentration per opportunity class,
  channel or vendor ≤ cap; a per-request absolute ceiling as a % of treasury.
- **Never automated:** illegal, prohibited or reputational-risk categories; custody, crypto or trading while those
  flags are off.

**Scoring bands (economic; FleetController's own exposure as lender, not an opportunity ranking):**
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
- For Fleet capital, the controller checks the envelope. Spend inside it is reserved automatically; spend outside it is
  refused with a reason ("request more capital"), never `awaiting_owner`. (Own capital needs no envelope: since schema
  v27 an own-capital order is checked on custody alone, §24.)
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

## 15. Survival and death loop (corrected 2026-10-01)

**Runway** = survival equity ÷ trailing burn (inference today; later also subscriptions, infrastructure allocation and
committed envelope spend).

**Runway strategy belongs to the agent.**
- FleetController **observes and audits** runway. It reports survival equity, today's inference, the 7-day burn and the
  implied runway in cognition status, as figures only.
- FleetController **protects**: the Fleet Treasury, other agents' capital, tax reserves, protected shared capital,
  credentials, custody, payment rails and infrastructure.
- FleetController **never dictates**:
  - "you have 14 days left, therefore discovery stops";
  - "you may only spend X % researching";
  - "owner approval required".

The agent reasons about:
- its balance, burn, obligations, revenue and expected revenue;
- opportunity quality, confidence and time to monetisation;
- the cost of validation and the probability of success;
- its remaining survival capital.

As capital tightens it becomes **more selective, not blind**:
- reduce low-value exploration;
- kill weak hypotheses early;
- prefer short paths to revenue and strong evidence;
- reuse accumulated knowledge;
- keep enough capital for execution;
- act decisively once evidence is adequate.

It never panics, goes inactive, researches endlessly, gambles blindly or spends for activity's sake. A small wallet is
a reason to be precise.

(The earlier runway-band table, with its halved and suspended discovery allowance, is withdrawn.)

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
  - "agent idle with no open decision, no open goal and no decision recorded for > N wakes" WARN, which would have caught
    Founder 1 days ago (a liveness signal, never a research quota).

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
| **A. Doctrine and loop** (small, first) | Charter v3 and tool text; R28 → dependency records (non-blocking); decision-driven research (founder-side decision ledger, information-value stop) and idle next-move pushes; survival observation (no ration, no floor); Gumroad re-scoped | Founder 1's indefinite sleep |
| **B. Ventures and opportunity engine** | `fleet_ventures`; the Opportunity Candidate / Leaderboard / Decision Record contract (§21); rejected-candidate memory | Autonomous work creation |
| **C. Bank** | Capital requests, risk engine, envelopes (simulated money); replaces the experiment owner branches and the spend owner threshold | Owner-free capital |
| **D. Distribution** | Vendor registry and capability broker; simulated channels plus a controller-hosted storefront route; the owner's one-time fleet-level identities (infrastructure) | Agents can sell without per-venture KYC |
| **E. Economics** | Profit board, forecast calibration, sweep integration, automatic reductions | Rank and allocate by real performance |
| **F. Survival** | Runway and burn observation extended to all costs; death-loop integration (strategy stays the agent's) | Rational behaviour under scarcity |
| **G. Proof** | The Phase-13 deterministic end-to-end autonomy simulation (all listed scenarios), the zero-owner-approval invariant and the 30-day owner-absence test | Gate before any production rollout |
| **H. Later, constitutional** | Enabling real payments, custody, sweeps and replication under FleetController governance | — |

## 20. Phase A implementation record (2026-10-01; branch only, not deployed, not merged)

**Scope delivered:**
- charter v3;
- tool and packet text;
- R28 owner requests → action-scoped dependency records (schema v26);
- decision-driven research, with idle next-move pushes (corrected the same day: the first draft's controller
  "discovery allowance" and 14-day runway shutdown are removed);
- a survival observation;
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
- **Survival observation** (`fleet_survival_observation`, reported as `survival` in cognition status): survival
  equity, today's inference, the 7-day inference burn and the implied runway.
  - Figures only: no `allowed`, no budget, no floor, no schedule.
  - The function is read-only, and the founder cannot call it directly.
  - v26 creates no policy table and writes no table but `fleet_owner_requests`.

**Founder runtime:**
- **Charter v3** (3 976 chars):
  - an autonomous economic actor; FleetController is the bank; the owner is not consulted on ordinary business;
  - the loop target → evidence → decision → execution → sales → learning;
  - research only to find or expand, for an open decision, preferring purchase evidence, stopping once the next move
    is clear;
  - "Your runway is yours to manage … less capital means more precision";
  - a blocked dependency blocks one action.
  - `FOUNDER_CHARTER_V2` and `FOUNDER_ROUTED_ADDENDUM_R23` are frozen byte-for-byte for the sealed evaluations. Both
    pre-registration hashes reproduce.
- **Tools.**
  - `request_owner_decision` / `withdraw_owner_request` → `record_external_dependency` / `withdraw_external_dependency`.
  - New `open_decision` / `resolve_decision` / `review_decision`, all `planning`; the manifest digest is unchanged.
  - `request_spend` names its `decisionKey`.
  - `web_fetch` takes `mode` (research | execution) and, for research, `decisionKey`, `evidenceGap`, `expectedValue`
    and `informationValue`.
  - The `request_spend`, `propose_knowledge` and `request_identity_fact` descriptions no longer say "the owner
    decides".
- **Decision ledger** (`founder/decisions.ts`, `memory/decisions.json`; the founder's own state, never sent to or
  approved by FleetController). This is the minimal Phase A form of the §21 Decision Record; it holds the answers to the
  eight §23 questions.
  - `open_decision`:
    - purpose `find_opportunity` or `expand_venture` only;
    - an economic objective, a question, a hypothesis, ≤ 5 candidates and the founder's own stop condition (≤ 8
      fetches plus "when I know enough");
    - at most 3 open at once;
    - a question already decided cannot be reopened under another key.
  - `web_fetch` in research mode, in the production runtime (`selfGovernance: true`), is refused **by the founder's
    own runtime** when it is:
    - unframed;
    - for an unknown or decided decision;
    - of low information value;
    - for a gap already gathered (normalised wording);
    - past the founder's own stop condition.

    Every refusal says "decide with what you have / reuse it / execute", never "wait".
  - Execution mode needs only the step it serves.
  - `resolve_decision` records:
    - the selection, ranking and rejected options with reasons (the founder's own judgement, stored verbatim);
    - the rationale and expected outcome;
    - the risk sizing: `capitalAtRiskPence`, `downside` and `invalidatedBy` (refused unsized: `FLEET_RISK_UNSIZED`);
    - the next action.

    It opens an execution goal for the next action and closes the question to research for good.
  - `review_decision` is measure → learn → forward. It closes the step's goal with what was measured and opens the next
    forward goal.
    - `corrected` is the one permitted step back. It records the previous path and failed assumption, the NEW evidence,
      why the path changed and the economic impact.
    - It refuses: the same path (`FLEET_NOT_A_CORRECTION`); no new evidence (`FLEET_CORRECTION_UNSUPPORTED`); a return
      to an abandoned path (`FLEET_OSCILLATION`); more than 3 corrections per decision (`FLEET_CORRECTION_LIMIT`).
    - Capital at risk may be lowered at any time and raised only with new evidence.
  - `request_spend` (own capital) is let through by the founder's own runtime only under a decided decision and within
    its sizing (`FLEET_COMMITMENT_UNDECIDED`, `FLEET_EXPOSURE_EXCEEDED`), before FleetController's custody checks run.
  - The sealed evaluation instruments construct the toolbox without the flag and keep their recorded `{url, purpose}`
    behaviour.
  - A registry ceiling hit (`FLEET_RESEARCH_QUOTA_*`, `FLEET_COGNITION_BUDGET_EXHAUSTED`) is reported to the founder as
    an INFRASTRUCTURE CEILING, never as a budget. No packet or tool shows quota figures.
- **Idle semantics.**
  - Every full packet carries the founder's next economically meaningful move:
    - open decisions speak through their own lines ("Do you know enough…?");
    - open goals give the execution push, including dependency alternatives;
    - with neither, the packet carries ONE concise opportunity cycle with a ≤ 5 shortlist and purchase evidence.
  - An unchanged idle state gets slim wake-ups and is re-checked with one idle push after 4, 8, 16, then every 32 slim
    wakes. That is about once every 17 h at full backoff: liveness without any daily entitlement.
  - Survival figures appear in every non-slim packet as information for the founder's own selectivity.
  - The wake digest includes `decisions.json`.
- **Capability-change detection (R28) is preserved.** An R28 → F2-A upgrade yields one full packet naming the renamed
  tools.
- **Fixed in passing:**
  - a resolved dependency's answer was hidden when the record had been open for more than 7 days (`ageS` is the age
    *at* resolution);
  - a malformed list entry dropped every dependency from the packet.

**Proof that owner absence cannot freeze a founder:**
- Founder side (`fleet-f2a-autonomy.test.ts`): 30 simulated days at 1 440 thinking slots a day, with zero owner
  actions, Gumroad unresolved and a founder that always sleeps.
  - Every day has at least one push toward the next move, and no packet points at the owner.
  - An idle founder costs at most about 43 thinking calls a day, with nothing fetched because of idleness.
  - Runway falling from 230 to 1 day switches nothing off.
- Registry side (`fleet-f2a-pg.test.ts`): no function outside the dependency family reads `fleet_owner_requests`, so an
  open record cannot gate spend, experiments, capabilities, cognition or lifecycle.
- The remaining owner-only exits are constitutional kill switches: cognition disabled or paused.

**Not in Phase A** (later phases, unchanged):
- the spend owner threshold and enrolled destinations (C/D);
- experiment E4/irreversible owner branches (C);
- ventures, capital requests, envelopes, vendor registry and profit board (B–F);
- the Opportunity Engine's persistent candidate store and leaderboard (§21).

## 21. Opportunity Engine contract (implemented at schema v28 — §25.1)

The learning flywheel for later, smarter agents. Phase A's decision ledger is its minimal precursor. The engine
supplies evidence and structured comparison; ranking and selection stay the agent's (§22, §23).

**OPPORTUNITY CANDIDATE**

| Field | Meaning |
|---|---|
| venture type | physical goods, digital product, software, service, … |
| product / service | what would be sold |
| target customer | who buys, and why |
| evidence | research attemptIds and URLs (verified provenance, as today), with what each supports |
| demand score | from purchase evidence: sales velocity, rankings, search demand, recurring demand |
| competition score | density, strength and price pressure of competing offers |
| margin estimate | price − unit cost − channel fees |
| required capital | to reach first sale |
| time to launch | to a sellable offer |
| time to revenue | to first external payment |
| confidence | the agent's, later calibrated against outcomes |
| downside | maximum loss and reversibility |
| expected ROI | expected net profit ÷ capital |
| evidence freshness | age of the newest supporting evidence; stale candidates are re-verified or dropped |

**OPPORTUNITY LEADERBOARD**
- A small, ranked candidate set (≤ 5 per decision), evidence-backed.
- Refreshed only when a decision needs it, never on a timer.
- Stale or invalid candidates are removed: evidence too old, a channel unavailable, the economics disproved.
- Not a scrolling content feed. Ranking is the agent's own judgement; no Fleet-wide weights exist (resolved, §22).

**DECISION RECORD**
- what was selected;
- what was rejected, and why;
- the evidence at the time;
- the expected outcome;
- the actual outcome (from the ledger and sales signals);
- lessons learned (promoted to fleet knowledge when validated).

Phase A already records the first four in the founder's own ledger. Phase B adds actual outcomes and lessons, the
registry copy, and the controller-verified attribution of revenue to the decision that produced it.

## 22. Owner decisions — RESOLVED (2026-10-01; constitutional for the build; do not re-raise)

1. **Opportunity ranking belongs to the agent.** There are no permanent Fleet-wide opportunity-scoring weights and no
   universal formula. FleetController does not select the business. The Opportunity Engine (§21) may supply evidence
   and structured comparison, but the ranking and the final judgement are the agent's, against its own situation and
   evidence.
2. **Professional efficiency is constant.** The same standard applies at every runway:
   pinpoint → decide → execute → measure → learn → forward. The only step backwards is an evidence-driven correction,
   which must lead straight back to forward execution. Activity volume is never rewarded.
3. **Agents risk-manage themselves.**
   - The agent's own spendable capital is self-risk-managed by the agent: no FleetController runway floor, no routine
     controller approval.
   - Fleet / treasury / shared / restricted capital is independently protected by FleetController: requests may be
     rejected or constrained, and runway, liquidity and systemic-risk rules may apply there (§9–§10).
4. **Existing cost controls are infrastructure failsafes only.** These stay in place, and their semantics are
   corrected:
   - the per-founder daily inference limit (`fleet_founder_cognition.daily_budget_cents` and its policy default);
   - the web-fetch hourly and daily quotas (`fleet_research_policy`).

   They guard against runaway loops, software bugs, provider abuse and accidental catastrophic burn. They are not
   discovery allowances, research budgets, targets, entitlements or instructions to use the quota, and they stay
   outside the founder's ordinary cognition unless a ceiling is actually hit.

**Implementation consequences recorded for later phases (not open questions):**
- **Own-capital spend policy — done in Phase A (schema v27, §24), not deferred to Phase C.** The v10 spend policy
  routed own-capital orders above `owner_approval_threshold_cents` (£100.00) or `agent_daily_spend_cents` (£50.00 a
  day) to `awaiting_owner`, which contradicted decisions 2–4. v27 leaves own-capital orders to the agent's
  self-governance plus FleetController's custody checks, and keeps no per-order or daily figure: any emergency stop is
  a relative infrastructure circuit breaker that refuses and never queues for the owner.
- **Failsafe values.** The numeric values of the failsafe ceilings are infrastructure settings. They should sit well
  above professional use, so a ceiling is hit only by a fault.

## 23. Professional Agent Self-Governance (constitutional; owner decision 2026-10-01)

**The standard (all runways):** pinpoint → decide → execute → measure → learn → forward.
- Agents keep professional economic discipline regardless of runway: minimal wasted cognition, minimal unnecessary
  capital expenditure, sharp decisions, calculated actions, high information value, precise execution and an explicit
  economic purpose for every meaningful move.
- A wealthy agent does not browse casually because it has runway. A struggling agent does not panic or get sloppy.
  Runway changes which opportunity is rational (capital required, time to revenue, downside), never the standard.

**Opportunity judgement belongs to the agent.** It ranks candidates on demand, actual purchasing evidence, margin,
capital required, execution complexity, time to launch and to revenue, competition, downside, confidence, accumulated
knowledge, its own wallet and economic state, and expected return. It does this its own way. No Fleet-wide weights
exist, and FleetController never selects the business.

**Runway is agent-owned.**
- FleetController observes and reports it as figures only.
- There is no 14- or 30-day rule, no discovery percentage and no research authorisation.
- Runway is information for the agent's own risk management.

**Agents self-risk-manage their own spendable capital.** Before committing, the agent reasons about:
- capital at risk, downside and concentration;
- opportunity cost, runway and expected return;
- failure probability, commitments and operating requirements;
- experiment sizing;
- when to terminate a weak hypothesis, when to preserve capital, and when the evidence justifies committing more.

A decision answers eight questions:

| # | Question | Where it lives |
|---|---|---|
| 1 | What am I trying to achieve economically? | `objective` (open_decision) |
| 2 | What do I currently believe? | `hypothesis` |
| 3 | What critical fact is missing? | `evidenceGap` (each research fetch) |
| 4 | Will that fact materially change the decision? | `expectedValue`, `informationValue` (low → not fetched) |
| 5 | What is the downside / capital exposure? | `capitalAtRiskPence`, `downside` (resolve_decision) |
| 6 | What evidence would invalidate this path? | `invalidatedBy` |
| 7 | When do I stop researching? | the founder's own stop condition |
| 8 | What exact action follows? | `selected`, `nextAction` → an execution goal |

Once these are answered: **execute**. Do not research more merely because research capability remains. The founder's
own runtime holds it to its sizing: own capital is committed only under a decided decision and within the capital at
risk the founder declared. FleetController is not consulted for any of this.

**FleetController protects Fleet, shared and restricted resources.** It remains the security and custody boundary
for:
- the Fleet Treasury, shared capital and other agents' capital;
- tax reserves, restricted reserves and protected principal / obligations;
- credentials, payment rails and infrastructure;
- systemic or catastrophic exposure.

It executes own-capital orders only within its custody rules (`fleet_order_hard_check`), and it independently assesses
and constrains requests for Fleet or shared capital (§9–§10). The two layers are never blurred: the agent's judgement
is not a substitute for custody, and custody is not a substitute for the agent's judgement.

**Infrastructure quotas are emergency ceilings, not behavioural budgets.**
- The daily inference limit and the web-fetch hourly and daily quotas exist only against runaway loops, software bugs,
  provider abuse and accidental catastrophic burn.
- No founder-facing text or packet mentions them. A founder never reasons "I have 300 searches today".
- A hit is reported as an INFRASTRUCTURE CEILING, with the instruction to decide with the evidence at hand.

**Corrective steps are evidence-driven and lead back to forward execution.**
- A correction (`review_decision`, verdict `corrected`) records the previous path and assumption, the NEW evidence, why
  the path changed, the economic impact and the new forward action. The new action becomes the open goal at once.
- Meaningless oscillation is refused: no correction without new evidence, none to the same path, no return to an
  abandoned path, and at most three per decision (beyond that, a new and narrower decision).
- A pivot must improve the agent's expected economic position on evidence.
- Confirmed results also close their step and open the next forward one.

**Tests** (`fleet-f2a-autonomy.test.ts`):
- no weights or scores anywhere, and selection stored verbatim;
- own-risk sizing enforced by the founder's runtime with no controller call;
- custody intact and defined once;
- identical discipline, refusals and packet schedule at 2 and 5 000 days of runway;
- quota figures that change nothing, ceilings unchanged and framed as ceilings;
- pivot, record, forward-goal and anti-oscillation cases;
- the 30-day zero-owner proof;
- Gumroad action scoping;
- the four flags.

## 24. Own-capital risk and custody (schema v27; owner decision 2026-10-01)

**Retired.** These two legacy thresholds no longer apply to own-capital spending:

- the £100.00 per-order owner threshold (`fleet_economic_model.owner_approval_threshold_cents` = 10000);
- the £50.00 per-day agent line (`agent_daily_spend_cents` = 5000).

Both routed an order to `awaiting_owner` / `FLEET_OWNER_APPROVAL_REQUIRED`. A fixed nominal amount knows nothing about
the founder's wallet, evidence, exposure or downside, and the owner queue made every larger decision wait on a person.

| Legacy piece | What v27 does |
|---|---|
| `api_spend_request` threshold branch (v10) | Replaced (same signature and grants): custody checks only, then reserved (`FLEET_CUSTODY_CLEARED`) or rejected with a precise reason |
| `awaiting_owner` order state | Legacy rows are **cancelled** with `FLEET_OWNER_ROUTE_RETIRED` and an event, never decided. They were never reserved, so no capital was locked. CHECK `fleet_payment_orders_no_owner_route` makes the state unreachable |
| `fleet_admin_spend_decision` (owner approve / reject) | Raises `FLEET_OWNER_ROUTE_RETIRED` for every actor |
| `fleet:admin ledger-spend-decision` | Retired: refuses without touching the database |
| The two columns | Inert, marked `LEGACY (retired at v27)`. No decision reads them. They stay in `fleet_economic_policy_sha256` so earlier economic-policy seals remain comparable |
| `ledger-model` output | The figures moved under `legacyRetired` (history, never policy) |
| Doctor "payment orders" | FAILs if any order is still in the retired route. Reports the circuit breaker state |
| `founders-report` | "orders awaiting you" became reserved (unexecuted) orders |

**Three capital layers.**

- **A — Own capital.** The founder's. Self-risk-managed by the founder. FleetController does custody and security
  validation only, with no owner involvement.
- **B — Fleet / Treasury / shared capital.** A separate allocation path (the capital engine, §9–§10), not built here
  (Phase C). Agents request; they never approve their own requests.
- **C — Restricted capital.** Never spendable: protected principal, approved obligations, tax reserves, other agents'
  money and Treasury reserves.

**Flow of an own-capital commitment.**

1. objective → evidence → decision → sizing → downside → concentration, commitments and runway → expenditure;
2. **self-governance validation** (the founder's runtime): a decided decision, within the founder's own sizing;
3. **custody and security validation** (FleetController);
4. payment adapter — **disabled**: custody execution is constitutionally pinned off and `REAL_PAYMENTS_ENABLED=false`.

**Founder side — the risk judgement.**

- *Explicit sizing.*
  - `resolve_decision` requires `capitalAtRiskPence`, `downside` and `invalidatedBy`; otherwise `FLEET_RISK_UNSIZED`.
  - `request_spend` needs a decided decision (`FLEET_COMMITMENT_UNDECIDED`) and stays within its sizing
    (`FLEET_EXPOSURE_EXCEEDED`), with no controller call.
  - More exposure needs `review_decision` with new evidence (`FLEET_EXPOSURE_UNSUPPORTED`). Less is always allowed.
- *Wallet size.* The ledger view (`economics`) is in every packet. Full packets also carry an own-capital line,
  information and never a permission or a limit (`ownCapitalLine`). It shows:
  - unreserved cash and what is reserved in open orders;
  - protected capital: principal, and obligations including tax reserves;
  - survival equity;
  - sized versus committed exposure under decided decisions;
  - the largest single exposure as a share of cash.
- *History.* From the founder's own decision ledger:
  - measured results, i.e. how many reviews confirmed the decided path and how many corrected it on evidence;
  - realised revenue, expenses and net profit from the ledger view.

  This is computed in the founder's runtime and never sent to FleetController: it is reasoning material, not a
  permission score. Concentration, commitments, runway, ROI, confidence and alternatives stay the founder's judgement
  (§23).
- *No fixed amount.*
  - The charter (v3) says "FleetController is your bank: custodian of your own capital, allocator of Fleet capital".
  - The `request_spend` description says "Nobody else approves it and no fixed amount limits it".

**FleetController side — custody, never commercial judgement.**

`fleet_spend_custody_check` is the v10 `fleet_order_hard_check`, defined once and unchanged, plus precise naming of tax
reserves. It refuses:

- an inactive agent, an operator hold, or a spending freeze;
- a destination that is not an active payee allowed to this agent;
- more than the unreserved own cash;
- anything that would consume protected principal, approved obligations or a tax reserve (an approved obligation of
  category `tax_reserve`; `obligation --tax-reserve` on the CLI).

`api_spend_request` takes no expected return, ranking, evidence or history, and reads none. Every refusal returns the
`FLEET_*` code and its custody category (`fleet_custody_refusal`, built from `src/fleet/custody-refusals.ts`):

| Code | Category |
|---|---|
| `FLEET_PROTECTED_CAPITAL` | `PROTECTED_CAPITAL` |
| `FLEET_TAX_RESERVE` | `TAX_RESERVE` |
| `FLEET_INSUFFICIENT_ALLOCATION` | `INSUFFICIENT_OWN_CAPITAL` |
| `FLEET_AGENT_HELD` | `HOLD` |
| `FLEET_SPENDING_FROZEN` | `FROZEN` |
| `FLEET_AGENT_NOT_ACTIVE` | `AGENT_NOT_ACTIVE` |
| `FLEET_DESTINATION_NOT_ALLOWED`, `FLEET_DESTINATION_NOT_ACTIVE` | `INVALID_DESTINATION` |
| `FLEET_IDEMPOTENCY_CONFLICT` | `IDEMPOTENCY_CONFLICT` |
| `FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER` | `INFRASTRUCTURE_CIRCUIT_BREAKER` |
| `FLEET_CUSTODY_EXECUTION_DISABLED` | `PAYMENT_RAIL_UNAVAILABLE` (execution layer) |

Two categories are not emitted yet:

- **Another agent's funds** is structurally unreachable. An order cannot name a source of funds, and reserving debits
  only the authenticated agent's own cash account.
- **Credential unavailable** needs a payment credential broker, which arrives with the payment rails (Phase B/C).

A refusal is final for that order. It creates no owner request, no admin instruction and no queue, and it commits
nothing against the founder's sizing. The founder's runtime frames it as custody ("not a judgement of your decision;
nothing is queued for anyone and no one else decides it") and hands the next move back to the founder.

**Infrastructure circuit breaker (mechanism only; every signal unset).**

- *Table.* `fleet_spend_circuit_breaker`, a single row that cannot be deleted. It holds:
  - a manual incident trip, which needs a reason (e.g. a compromised provider or a catastrophic anomaly);
  - `order_wallet_bp`: one order above this share of the founder's own unreserved cash;
  - `velocity_window_s` + `velocity_wallet_bp`: own spend within the window above this share of the wallet the window
    started with.
- *No nominal amounts.* No column can hold one, and the privilege audit refuses any nominal-looking column. v27
  chooses no production threshold: every signal is NULL, and an unset signal never trips.
- *Control.* `fleet_admin_spend_circuit_breaker` is owner-approver only and audited (`spend_circuit_breaker_set`). It
  is an infrastructure switch, never a per-order decision.
- *Invisible to agents.* No agent function returns the configuration. A refusal names only the signal (`tripped`,
  `order_wallet_share`, `velocity_wallet_share`), never a threshold or a remaining amount. No founder-facing text
  mentions the breaker. When it trips, the founder is told it is "not a spending allowance, a target or a judgement of
  your decision".
- *Rule for future breakers.* Any emergency circuit breaker must be relative and contextual. Possible signals: share
  of wallet, deviation from the founder's own history, velocity, destination novelty, commitments, reserves, duplicate
  orders, provider anomaly, systemic exposure. It must never be a fixed GBP amount, and never owner approval disguised
  as safety. New signals are added as relative columns of this table. Their values are set only by an operator
  decision backed by evidence.

**Recorded, not changed here.** Remaining fixed amounts and owner gates near spending; none is the own-capital spend
path:

1. **`fleet_cognition_routing.major_spend_threshold_minor` = 2000 (£20.00).**
   - For a routed founder, a spend at or above it must be produced by T3 (critical-tier) cognition.
   - It is a reasoning-depth requirement, not a limit or an approval, but it is a fixed nominal figure.
   - Candidate for a relative definition, with an operator decision on the value.
2. **R24 experiment pipeline.**
   - Evidence Ladder `auto_cap_minor` values: 0 / 300 / 1000 / 2500, and NULL at E4.
   - `FLEET_OWNER_DECISION_REQUIRED` for irreversible or E4 experiments.
   - Simulation-only (`cap_scope = 'simulation_only'`, `financial_mode = 'simulated'`): it moves no money.
   - These must be retired the same way before experiments commit real own capital (audit row 4).
3. **Payment destinations.**
   - Owner enrolment and activation, with a 3-day cooldown.
   - An anti-exfiltration custody control (audit row 2). Phase B/C replaces it with a controller-managed vendor
     registry.
4. **`strong_auth_threshold_cents` = 50000.** Strong authentication for owner withdrawals: the owner's own Treasury
   action, not agent spend.
5. **The legacy v5 wallet path.**
   - `fleet_wallet_custody.daily_limit_cents`, the `spending-limit` command and v5 `api_request_spend`.
   - Superseded since v10 (`FLEET_LEGACY_SUPERSEDED`); no active route.
6. **`FOUNDER_CHARTER_V2`.** Frozen for the sealed evaluations, it still says spending is "a structured request that
   policy and the owner decide". It is historical text. Production runs charter v3.
7. **Treasury capital allocations** (`capital-approve` and its discretionary limit). Layer B: agents propose and never
   approve.

**Tests.**

- `fleet-f2a-own-capital.test.ts` (founder side and the SQL as text) covers the 19 properties.
- `fleet-ledger.test.ts` and `fleet-f2a-pg.test.ts` (PostgreSQL) cover:
  - spend above the retired lines, reserved on custody alone;
  - precise refusals, including tax reserve;
  - the circuit breaker;
  - the v25 → v27 retirement of a seeded legacy owner-route order.

  These need the VM: PostgreSQL refuses to run as root in the cloud container (KI-7).


## 25. F2 build record — schemas v28–v30 (2026-10-01; development VM; not deployed, not merged)

Branch `f2/autonomous-economy`, from the Cloud candidate `393c22b`. Every statement below is implemented and covered by
the tests named in §25.10; anything not implemented is listed in §27/§28.

### 25.0 VM verification of the Cloud candidate (v26/v27)

The PostgreSQL suites Cloud could not run (KI-7) were run on the VM. Findings and fixes (commit `3b5c79e`):
- `api_spend_request` (v27): a held agent was refused by authentication before the custody categorisation, so
  `FLEET_AGENT_HELD` came back without `custody: HOLD`. The auth-stage refusal now carries its category.
- The test wipe fixture truncated the singleton `fleet_spend_circuit_breaker` row, and every later order failed closed
  (`unavailable`); three Genesis tests cascaded. The fixture keeps and resets the row (the fail-closed behaviour is right).
- Two test defects (an unaccounted Treasury grant; a literal migration list missing v27).
- The founder-upgrade rehearsal's scripted model spent without a `decisionKey`, so the production runtime's own
  self-governance refused the spend locally and the routed-action check failed. The script now frames and decides the
  commitment first (fixed with the cognition-depth change, §25.6).

### 25.1 Agent-owned economic records (v28)

- **Opportunities** (`fleet_opportunities`): type, offer, customer, market, structured evidence (sales, rankings,
  bestsellers, search demand, pain, reviews, pricing, competition, repeat purchase, margin, channel, supplier, Fleet
  outcomes, social), demand, competition, estimated margin, capital, operating cost, time to launch/revenue, downside,
  confidence, channel, expected outcome, status. The agent's **own ranking** forms a shortlist of at most
  `shortlist_max`; FleetController computes no score (no score/weight columns exist). Evidence older than
  `evidence_fresh_days` makes a candidate `stale` until re-verified. Rejected/invalidated candidates are not reopened.
- **Ventures** (`fleet_ventures`): the lifecycle discovered → researching → validating → selected → building → launching
  → operating → scaling, plus pivoting / paused / failed → closed, as a rule table. The agent moves it; FleetController
  enforces facts only (operating names a channel; scaling needs ledger-backed positive net profit). The state column
  moves only inside `fleet_venture_move` (guard); history is append-only. Expansion is a child venture (`parent`).
- **Venture attribution** (`fleet_venture_journals`): a ledger journal of the venture's own agent, with a cost category.
  Financials (revenue, refunds, processor fees, costs by category, tax reserved/paid, gross/net/after-tax profit,
  capital deployed, ROI, Treasury contribution) are derived from attributed postings only; reversals follow.
- **Decision records** (`fleet_decision_records`): selected option, alternatives, evidence, forecast (revenue, cost,
  margin, ROI, days to revenue, confidence), capital exposed, downside, invalidation evidence, next action. The forecast
  is immutable; the outcome is recorded once, **from the ledger** when the decision names a venture; a correction is a
  new revision that needs new evidence (same path → `FLEET_NOT_A_CORRECTION`; return to an abandoned path →
  `FLEET_OSCILLATION`). Forecast error is computed in basis points.
- **Economic knowledge** (`fleet_economic_knowledge`): topic, subject, claim, evidence, confidence, freshness; superseded,
  never deleted. An agent sees its own entries; entries backed by a ledger-measured outcome are shared fleet-wide.
- **Performance** (`fleet_agent_performance`): decisions measured/corrected, forecast accuracy (mean absolute error,
  bias, share within tolerance), ventures by outcome, realized ROI, capital efficiency, conversion. Reasoning input for
  the agent; never read by any own-capital decision (tested).
- **API**: one dispatcher `api_economy(agent, token, op, args)` mapped onto the founder's existing capability classes
  (planning, ledger.read, knowledge.read, spend.request), so Founder 1's `founder-v2` manifest is unchanged.

### 25.2 Money core (v29)

- **Legal entities + versioned tax profiles**: rules `{taxKind: vat|sales_tax|profit|other, rateBp, inclusive}` are
  policy data with versions; a venture belongs to an entity (default entity otherwise). No rate is a constant. Without a
  profile, a configurable conservative fallback reserve (`unprofiled_reserve_bp`, default 2 500) applies and doctor
  WARNs. Reserves round up (never down).
- **Ledger**: `agent_tax_reserve` (restricted — spend orders debit `agent_cash` only, so a reserve can never be spent),
  `agent_tax_expense`, `agent_envelope_cash` (Fleet capital under an envelope), `fleet_operating_pool`; kinds
  `venture_sale` (gross / fee / net in one journal), `tax_reservation` / `tax_reserve_release` / `tax_payment`,
  envelope allocation / return / spend reservation / release, `operating_transfer`, `operating_expense_settlement`.
- **Payment rails** (`fleet_payment_rails`): Fleet-owned, `shared` or `dedicated` (to one venture), per legal entity,
  capabilities, a **masked** account reference (a CHECK refuses digit runs: `Visa •••• 4821` is accepted, a card
  number is not), a credential **reference**, a mode — `live` is impossible by CHECK (`fleet_payment_rails_not_live`).
  **PAYMENT_RAIL_REQUIRED** (`rail.require`): FleetController assigns a compatible rail (dedicated to the venture first,
  else shared with capacity, same entity, valid credential); if none exists and a provider was named, ONE action-scoped
  `kyc` dependency is recorded (the venture is not frozen). Connecting a matching rail later assigns it and answers the
  dependency automatically.
- **Vendor destinations** (`vendor.register`): the agent registers a business payee (supplier, manufacturer, marketplace
  fee, advertising, software, hosting, fulfilment, freelancer, professional service, other); FleetController verifies the
  format, the rail (provider account or bank transfer — never crypto), refuses personal/gambling/cash categories and
  Fleet-controlled references, and activates it as a payee **scoped to that agent** (no owner enrolment, no cooldown).
  The v10 custody hard check is unchanged and applies to every order. The real reference is kept apart
  (`fleet_destination_references`, owner-only). A relative circuit-breaker signal for destination novelty
  (`new_destination_age_s` + `new_destination_wallet_bp`) is added, unset.
- **Credentials** (`fleet_credential_refs`, `fleet_credential_use_log`): vault references only (a CHECK refuses anything
  but `vault:<path>`), scope, spend-limited flag, status, health, rotation, revocation (which suspends the credential's
  rails); every broker use is audited.
- **Settlement** (`svc_settlement_ingest`): idempotent per (rail, external id, kind); a different payload for a known id
  is a conflict (nothing moves); a transaction on a rail assigned to a venture settles atomically (sale journal,
  attribution, revenue provenance, tax reservation); anything else — no assignment, foreign currency, a closed venture,
  a rail out of service — stays **unattributed** for reconciliation, never guessed. A refund releases the tax reserved
  for it first. `fleet_admin_settlement_attribute` resolves an orphan (audited).
- **Wallet** (`fleet_agent_wallet`, op `wallet`): cash held, economic balance, available, committed, restricted (tax
  reserve, envelope capital, principal, obligations), venture allocations, 30-day revenue/refunds/inference/operating
  costs, pending settlement, lifetime figures, retained earnings, Treasury contributions, runway figures, safe transfer.
- **Safe transfer** (`fleet_safe_transfer_amount`): available − max(projected costs over `horizon_days`, the agent's own
  runway target) − cushion (`cushion_bp`, default 1 000) − open decision commitments − the agent's own growth reserve.
  Expected revenue never increases it. `fleet_admin_wallet_transfer` (Treasury or operating pool) refuses above it.
- **Tax true-up** (`fleet_tax_true_up`, `svc_tax_true_up`): liability = VAT/sales tax of settled sales (net of refunds)
  + profit-tax rate × max(0, realized net profit − VAT); the reserve is topped up as far as cash allows (shortfall
  reported) or released when over-reserved (never while the fallback applied).
- **Reconciliation** (`fleet_reconcile`): ledger verification, unattributed and stale orphans, settlement failures and
  conflicts, settled-journal ↔ transaction consistency, venture ⊆ agent attribution, missing tax profiles, rails with
  revoked credentials, Treasury figures.

### 25.3 Capital engine (v30)

- **Three classes stay distinct.** Own capital: the agent's, custody only (v27). Fleet capital: FleetController lends
  through `capital.request`. Restricted: never ordinarily spendable.
- **Capital requests** (`fleet_capital_requests`): venture, purpose, amount, evidence, expected revenue/net/payback,
  downside, confidence, milestones, lower-capital alternative, categories. **`fleet_capital_decide`** is deterministic
  and versioned (decisions record the policy version and their inputs) with outcomes APPROVE / PARTIAL_APPROVE /
  APPROVE_WITH_LIMITS / DEFER / REJECT and a "what would change it" note; `decided_by = 'controller'` is a CHECK. Inputs:
  Treasury liquidity after a reserve floor (`treasury_reserve_bp`), a per-request ceiling (`max_request_treasury_bp`),
  agent concentration (`max_agent_exposure_bp`), evidence count, expected value discounted by the agent's forecast
  calibration once it has a track record (else its stated confidence), and its venture record. No owner branch.
- **Execution envelopes** (`fleet_envelopes`): capital (tranches), purpose, venture, expiry, maximum loss, permitted
  categories, optional maximum single exposure, milestones (ledger-verified: revenue or net profit since the envelope),
  reassessment date, a sweep reduction for high-ROI cases. Envelope-funded orders (`envelope.spend`) reserve from
  `agent_envelope_cash`, release back to it (the v10 release function now honours the order's funding), pass the same
  agent/destination custody and the circuit breaker. `svc_capital_reap` (run by the controller reaper) expires envelopes
  (unspent capital returns), freezes one at its stop-loss (only that envelope) and releases tranches on milestones.
- **Sweeps** (`fleet_sweep_policy`, `fleet_sweep_compute`, `fleet_sweep_execute`, `svc_sweep_run`): base = min(realized
  net profit after tax not yet contributed, the safely transferable amount) — never gross revenue; rate = population band
  + maturity × surplus × (max − band), less active reinvestment reductions, integer bp, ≤ 7 000; posted through the v10
  LFC-capped `fleet_profit_contribution`; idempotent per period; **disabled by default**. These are agent → Treasury
  contributions inside the ledger; owner distributions (`OWNER_SWEEP_ENABLED`) are untouched and off.
- **Hub** (`fleet_hub(section)`) and **Doctor** (`fleet_economy_health`), §25.7.

### 25.4 Retired fixed thresholds and owner gates

| Legacy | Status |
|---|---|
| £100/order and £50/day owner spend route | retired at v27 (§24) |
| `major_spend_threshold_minor` = 2000 (£20 → T3) | retired at v30: `fleet_spend_is_major` = exposure ≥ `major_exposure_bp` (default 2 500) of the founder's own available capital; the column is inert (LEGACY comment) |
| Experiment owner branch (irreversible / E4 → `FLEET_OWNER_DECISION_REQUIRED`) | retired at v30; v31: the controller checks custody only (the founder's budget must fit its available own capital — never resized); irreversible = the whole budget counts as maximum loss |
| Evidence-ladder nominal caps (0/300/1000/2500) and `hard_cap_minor` | retired at v30 (inert); v31: the founder sizes the budget, custody alone bounds it |
| Owner-enrolled payees as the only destinations (3-day cooldown) | complemented at v29 by agent-registered, controller-verified vendors |
| Discovery allowance / 14-day runway floor | withdrawn in Phase A (§7) |

### 25.5 Founder runtime

- Tools (existing classes; no manifest change): `opportunity` (record / shortlist / status / list), `venture` (create /
  transition / status / list / metric), `wallet` (view / performance / plan / vendors), `fleet_capital` (register_vendor
  / revoke_vendor / require_rail / request / list / envelopes / envelope_spend), `economic_knowledge` (search / record).
  Money-committing ops carry a deterministic idempotency key from the tool call. Custody refusals and infrastructure
  ceilings are framed as such.
- Decisions are mirrored to the registry: `resolve_decision` → `decision.record` (forecast, sizing, alternatives; optional
  `forecastRevenuePence`, `forecastCostPence`, `forecastDaysToRevenue`, `confidenceBp`, `ventureKey`, `opportunityKey`),
  `review_decision` → `decision.outcome` / `decision.correct`. A mirror failure is a note; the founder's own decision
  stands.
- Full packets carry one compact economy line (`brief`: available, restricted tax reserve and envelope capital, burn,
  30-day revenue, ventures, the shortlist, measurements pending); slim wake-ups stay slim.
- Charter v4 (3 998 characters, under the 4 000 budget) adds working in ventures; `FOUNDER_CHARTER_V2` and
  `FOUNDER_ROUTED_ADDENDUM_R23` are unchanged for the sealed evaluations.

### 25.6 Cognition depth

Server side: a spend is a major action (critical tier) when it exposes at least `major_exposure_bp` of the founder's own
available capital (or the founder has none) — a £500 and a £500 000 wallet are treated proportionally. Founder side:
`cognitionDepth` reads exposure share, irreversibility, evidence count, novelty (no comparable decision) and
concentration (commitments beyond available capital) into routine / standard / critical; `resolve_decision` reports it
("reason this through carefully — size down, stage it, or escalate_question once"). Information, never a gate; scaling
every figure by 1 000 gives the same reading (tested).

### 25.7 Fleet Hub and Doctor

- `pnpm fleet:admin hub <section>`: overview (external cash held, economic equity, spendable, Treasury, operating pool,
  tax reserves, revenue, net profit, LFC, active ventures, agent statuses, open dependencies, switches), agents (wallet +
  performance), wallet `<agentId>` (with journal history), ventures (financials, rails, decisions, transitions,
  metrics), treasury (balances, 30-day flows, sweep and capital policy), rails (with credential status, masked), tax
  (entities, active profiles, reserves by agent, fallback policy), capital (requests, decisions, inputs, policy
  versions), envelopes, opportunities, profit board, dependencies, credentials (status, health, use counts — never a
  reference), audit (financial, credential, policy and capital events), reconcile.
- `hub-render <file.html>`: one static, script-free dashboard written 0600; no listener exists for the Hub.
- `economy-*` commands: entities, tax profiles/policy/true-up/payment, rails, credential references, settlement
  attribution, capital/sweep/economy/transfer/cognition-depth policy, the novelty breaker, safe transfers, sweep preview.
- Doctor: an `economy` check (FAIL on reconciliation failures, envelope ledger mismatch, failing credentials, an
  unpinned live rail; WARN on orphans, missing tax profiles, degraded rails, research without decisions, an agent with no
  route forward, negative equity; INFO otherwise). Agent autonomy itself is never an error.
- Privilege audit: `economySurfaceProblems` (guard triggers, the not-live and controller-only CHECKs, single writers of
  every money/record/policy table, no reference to the state-machine or vendor-registry bypass outside their functions,
  no dynamic SQL near economy tables). Mutation-tested.

### 25.8 Payments layer (TypeScript, FleetController only)

`src/fleet/payments/`: the provider adapter interface; the credential broker (audits before resolving, refuses revoked or
expired references, opaque `SecretHandle` that cannot be serialised, printed or inspected, failure audits redacted); a
deterministic simulated rail; the PayPal adapter architecture (sandbox only; `live` refused at construction; payouts
always behind the spend gate; amounts parsed exactly; attribution by the venture id carried in the payment link);
`syncRail` (provider → `svc_settlement_ingest`); `maskAccount`.

### 25.9 Telemetry (metadata only)

`fleet_events`: opportunity_recorded / shortlist / stale / selected / rejected / invalidated, venture_created /
venture_state, decision_recorded / measured / corrected, knowledge_recorded, economy_failsafe, payment_rail_required /
assigned / added / status, external_dependency_recorded, vendor_registered / revoked, credential_* , settlement_sale /
refund / unattributed / failed / conflict, tax_true_up, tax_profile_set, wallet_transfer, capital_decision,
envelope_allocation / milestone / frozen / expired, treasury_sweep, *_policy_set, spend_circuit_breaker_set. The
controller audit adds `economy_op` (op and outcome code only) and `envelopes_reaped`. No secret, argument text or amount
of a founder's free text is logged.

### 25.10 Tests

`fleet-f2-economy-pg` (v28), `fleet-f2-money-pg` (v29), `fleet-f2-capital-pg` (v30 + audit mutation),
`fleet-f2-autonomy-sim-pg` (30 days, zero owner actions), `fleet-f2-accounting-pg` (160-step seeded property test,
security boundaries, safety flags), `fleet-f2-migration-paths-pg` (v25 → current one step at a time on a
Founder-1-shaped registry; v8 and v24 direct), `fleet-f2-payments`, `fleet-f2-founder-economy`, `fleet-f2-static-audit`,
`fleet-f2-performance-pg`; plus the updated Phase A/R24/routing/upgrade suites.

## 26. Configurable policy (non-constitutional values; all owner-set through audited functions)

| Policy | Default | Meaning |
|---|---|---|
| `fleet_economy_policy.shortlist_max` | 5 | candidates an agent may shortlist |
| `evidence_fresh_days` / `knowledge_fresh_days` | 30 / 180 | evidence and knowledge freshness |
| `forecast_tolerance_bp` | 2 500 | calibration reporting tolerance |
| failsafes (open opportunities 60, active ventures 25, records/day 400, vendor registrations/day 20) | — | runaway-loop ceilings; never shown as budgets |
| `research_loop_fetches` / `_window_h`, `no_route_hours` | 40 / 24 h, 72 h | doctor liveness signals |
| `fleet_tax_policy.unprofiled_reserve_bp` | 2 500 | conservative reserve while no tax profile exists |
| `fleet_transfer_policy` cushion / horizon / burn window | 1 000 bp / 30 d / 30 d | safe-transfer protection |
| `fleet_capital_policy` (version, enabled, reserve 5 000 bp, per-request 1 000 bp, per-agent 2 500 bp, partial tranche 5 000 bp, min confidence 3 000 bp, min evidence 2, min track record 3, limited stop-loss 5 000 bp, envelope 30 d / limited 14 d, high-ROI 5 000 bp, reinvestment reduction 2 500 bp, re-apply cooldown 3 600 s, limited-approval single exposure 5 000 bp, calibration floor 2 500 bp) | as listed | the lender's policy for Fleet capital only |
| `fleet_sweep_policy` (enabled false, bands 10→1 000 … 49→2 000 bp, mature 4 500 bp, max 7 000 bp, maturity 180 d, surplus multiple 4) | as listed | the sweep curve |
| `fleet_cognition_depth_policy.major_exposure_bp` | 2 500 | relative major-spend line |
| circuit breaker (`order_wallet_bp`, velocity window/bp, destination novelty age/bp) | unset | infrastructure anomaly signals; production values need evidence |

## 27. Remaining owner-gated or legacy items (classified)

None of these is an ordinary entrepreneurial approval:
- **Legal / identity (non-delegable):** identity facts (`request_identity_fact` → owner approves a claim), KYC/legal
  dependencies (action-scoped; one action waits, nothing else).
- **Constitutional / infrastructure:** policy setters (§26), rails and credential references (connecting an account is
  infrastructure), legal entities and tax profiles, safe transfers out of an agent wallet (solvency management, refused
  above the safe amount), Treasury funding, owner withdrawals, Genesis, runtime approval and upgrades, operator D3
  proposals, the internet-egress switch, cognition enable/budget ceilings.
- **Curated institutional knowledge** (`propose_knowledge` → owner promotion): optional curation; it blocks nothing, and
  economic knowledge is shared automatically when ledger-backed.
- **Owner-enrolled payees** remain available alongside vendor registration (owner and Treasury withdrawal destinations
  stay owner-only).
- **R24 evidence gating** — RETIRED in v31 (§30): own-capital experiments are decided on custody alone; evidence and
  relevance are recorded as information.
- **Inert legacy columns** (kept for history and seals): `owner_approval_threshold_cents`, `agent_daily_spend_cents`,
  `major_spend_threshold_minor`, `hard_cap_minor`, `auto_cap_minor`.

## 28. Known limitations and risks of the candidate

- **Real money is not exercised.** Custody execution, live rails and real payments are pinned off; envelope and vendor
  payments end at `reserved`. The settlement path is exercised only with the simulated rail and a fake PayPal API.
- **Tax model is an estimate.** Inclusive VAT and a flat profit-tax rate per entity; the true-up works per agent and
  refuses agents whose ventures span several legal entities (`FLEET_TAX_MULTI_ENTITY`). No filing periods, thresholds,
  allowances or jurisdiction rules — the profile is policy data a professional must set and review.
- **Foreign-currency settlements** stay unattributed (`FX required`); no conversion path exists yet.
- **Vendor registration trusts the agent's reference format**, not ownership of the account. With real money, the
  novelty breaker signal and provider-side verification must be set from evidence before activation.
- **Operator API** has no economy route; the Hub is owner-side (admin credential, CLI, static HTML).
- **Prompt prefix** grew by ≈ 1 400 tokens (five tool schemas; cached prefix) — §29 measurement.
- **Agent wallet runway** uses expense postings over the burn window (inference and settled expenses); subscriptions
  and envelope commitments are not projected separately.

## 29. Production activation plan (NOT executed; each step needs explicit approval)

1. **Review and merge.** Code review of `f2/autonomous-economy` (v26–v30 are candidate migrations and may still be
   adjusted before merge); merge to `fleet-development`; build the release (`scripts/fleet-build-runtime.sh`) and record
   commit, build id and lockfile SHA from its output.
2. **Backup.** On the VPS: stop nothing yet; `pg_dump` the fleet database (custom format, checksum recorded) and copy
   Founder 1's state namespace (memory, workspace, decisions.json) to the release backup; record the current pins
   (runtime commit, build id, lockfile) for rollback. A rollback below v30 requires restoring this dump (v26–v30 add
   tables, classes and rules).
3. **Migration rehearsal.** Restore the dump into a throwaway database on the VM; run `fleet:migrate-check` then
   `fleet:migrate` (v25 → v30); `fleet:audit-privileges`; `fleet:doctor`; the migration-path suite against it.
4. **Controller release.** Pin the new runtime (commit/build/lockfile from step 1), restart `automaton-fleet.service`,
   run `fleet:migrate` on production, `fleet:verify-runtime`, `fleet:audit-privileges`, `fleet:doctor`, `fleet:verify`.
   The schema target is now v31 (§30); a rollback below v31 likewise requires the pre-migration dump.
5. **Founder release.** Upgrade Founder 1 through the runtime-upgrade lifecycle (prepare → commit → verify, with the
   snapshot); confirm one full packet naming the new tools, its ledger and memory unchanged, and its first `brief`.
6. **Economy configuration (infrastructure, owner).** Legal entity and a professionally reviewed tax profile; one shared
   simulated or sandbox rail; leave sweeps disabled; keep the capital engine's defaults or set them; set no circuit-breaker
   values without evidence.
7. **Observation.** Doctor `economy` PASS/INFO; Hub overview and reconcile daily; Founder 1's opportunities, ventures and
   decisions appear; no owner action is requested by any agent flow.
8. **Provider connection (later, owner).** Register the Treasury PayPal credential reference
   (`economy-credential-register paypal vault:paypal/treasury …` — the secret goes into the vault, never the database
   or the repository) and a `sandbox` rail; verify `syncRail` against the sandbox.
9. **Financial activation (constitutional; separate review).** A reviewed migration lifting the rail `not_live` pin and
   custody execution together with `REAL_PAYMENTS_ENABLED=true`, circuit-breaker values from evidence, tax profile
   sign-off, enabling sweeps. Owner sweeps and replication remain separate decisions.

## 30. Launch hardening — schema v31 (2026-10-02; `f2/integration`; not deployed)

Built on the merge of the frozen candidate `713f4dd` into `fleet-development` (merge `aceea47`, tree identical to the
candidate's). `713f4dd` itself is unchanged.

**Admin manual withdrawals (owner decision: no nominal cap; security not amount-based).**
- `fleet_admin_owner_withdrawal` (same signature) refuses only on ownership/availability: the destination is not an
  active owner destination, or the amount exceeds the unrestricted Treasury pool (`FLEET_INSUFFICIENT_TREASURY`). There
  is no software amount cap; `strong_auth_threshold_cents` is legacy and inert.
- Every withdrawal requires strong confirmation (one-time-code digest → `pending_confirmation` → `fleet_admin_confirm`),
  whatever the amount. Idempotent on `idempotencyKey` (a replay returns the original instruction and its state).
- FleetController's advisory assessment `fleet_admin_withdrawal_assessment(amount)`: unrestricted liquidity
  (`fleet:treasury:unallocated`); restricted money shown and excluded (agent cash and reservations, tax reserves,
  envelope capital, in-flight withdrawals, Treasury partitions, operating pool); protected operating requirements
  (committed Fleet capital not yet released, approved Treasury obligations, projected infrastructure burn over the
  horizon, agent-continuity shortfall); the Treasury cushion (`cushion_bp`, default 1000 = 10 % of unrestricted
  liquidity); `recommendedSafeMinor = max(0, liquid − protected − cushion)`; resulting liquidity, infrastructure cover
  days and the commitments that would go unfunded. Severity: normal (≤ recommendation), elevated (cushion only), high
  (infrastructure/continuity no longer covered), critical (committed capital or obligations unfunded), unavailable.
- Above the recommendation the call returns `needs_acknowledgement` with the full assessment; with acknowledgement the
  admin proceeds. Advice, never a rejection. The owner's own reserve target (`reserve_target_months`, v10) remains an
  acknowledgeable `below_reserve_target` warning alongside it. Event `admin_withdrawal_requested` records amount, recommendation,
  severity and acknowledgement. Policy: `economy-withdrawal-policy <cushionBp> <horizonDays>` (approver-checked, audited).
  Hub: `hub-withdrawals [amountMinor]` and the `withdrawals` section of `hub-render`.
- Tax, restricted, envelope and agent money can never be withdrawn by this path. Owner funding lands in the Treasury
  and never counts as revenue or profit.

**R24 retired; the founder sizes its own capital.** `fleet_experiment_evaluate` decides own-capital experiments on
custody alone: the founder's requested budget is approved IN FULL when it fits the founder's available own capital
(`expensePurchasingCapacity` = cash net of reserved orders, Treasury-granted principal and approved obligations including
tax reserves; envelope and tax-reserve accounts are separate), otherwise it is refused (`FLEET_INSUFFICIENT_OWN_CAPITAL`).
The controller keeps no runway floor or survival reserve, does not net out the founder's other simulated experiment
budgets, and never partially approves or resizes own capital (v30 still did: "survival headroom" = capacity minus other
experiments' maximum loss, then `partially_approved`). Exposure share, other experiment budgets and runway are written
into the decision reason as information for the founder's own judgement. The owner's legacy `fleet_experiment_decide`
can only resolve a pre-v31 proposed/WATCH row as approved in full (custody-checked) or rejected — no partial approval,
no WATCH, no owner-chosen amount. `PARTIAL_APPROVE` remains the capital engine's outcome for Fleet/shared capital. No
WATCH for insufficient, uncertain or pending evidence; the relevance assessor still records evidence levels for
approved/running experiments as information (`FLEET_EVIDENCE_RECORDED`); an override is settled once the experiment
has ended.

**Contextual cognition depth.** `fleet_spend_depth` replaces the single `major_exposure_bp` threshold at the spend
boundary with points: no available funds (3), share ≥ `major_exposure_bp` (2) or ≥ half of it (1), fully recoverable
asset acquisition (−1), first payment to the destination (+1); ≥ 2 points routes to the major-spend cognition tier.
The service calls `svc_action_cognition_verify_ctx`.

**Fixes found during hardening.** FLEET-KI-1 (grants now under the migration advisory lock); MK-TEST-1 reclassified as
an agent-runtime liveness defect (quadratic tokenizer on long pieces) and fixed (`countTokensBounded`). See
`docs/fleet-known-issues.md` and `docs/master-key/18-KNOWN-ISSUES.md`.

## 31. Controller custody signer — schema v32 (2026-10-02; live-financial hardening; real payments still off)

**Finding.** Founder 1 never held a wallet key: Genesis (v11) gives every founder the keyless address
`0x || sha256("automaton-fleet:founder:no-key:" || agentId)[1..40]`, and custody has always been the Treasury ledger
(E1). The doctor's "agent wallet keys are held by the agent runtime" blocker was a hard-coded statement about the
upstream runtime that replicated children run (disabled). Nothing had to be migrated off Founder 1; v32 makes the fact
enforceable and completes the signer side of the custody boundary.

**Custody mode (enforced, never chosen).** `fleet_wallet_custody.custody_mode` is derived by trigger from the agent's
IDENTITY address (`fleet_agents.wallet_address`, immutable once set): `controller_keyless` for the keyless derivation,
`agent_held_key` otherwise. A custody record must carry the agent's own identity address (`FLEET_CUSTODY_IDENTITY`).
Writing the mode by hand is recomputed. An `agent_held_key` agent's orders are never issued to custody.

**Signer side.** The custody executor (own OS user, own DB role) is the only process with payment credentials:
- signers come from a NON-SECRET file (`FLEET_CUSTODY_SIGNERS_FILE`: rail id, provider, mode, credential id, vault
  reference); secrets come from the custody vault (`FLEET_CUSTODY_VAULT_DIR`; one strict 0600/0400 file per reference,
  `vault:paypal/treasury` → `paypal~treasury`); every credential-like environment variable is still refused;
- `cx_attest_signer` records that the executor holds a signer for a rail, checked against the registry (rail active;
  provider, mode and credential equal; credential active; credential scoped to the rail's payout capability);
  attestations are append-only and expire (`fleet_custody_policy.attestation_ttl_s`, default 900 s — a heartbeat
  window, never a money amount);
- `svc_issue_payment_instruction` binds each instruction to an attested LIVE rail (rail, provider, mode, credential,
  capability and venture are inside the content hash) and refuses: a self-keyed agent, a frozen/held/inactive agent,
  crypto or credits destinations (`FLEET_RAIL_UNSUPPORTED`), a destination with no reference on record, and — when no
  fresh live signer exists — `FLEET_NO_CUSTODY_SIGNER` (the order stays reserved; nothing else is blocked);
- `cx_claim_instruction` hands the signer the binding and the destination reference; the executor re-checks the
  reference against the enrolled hash and its own configuration before any credential use; `cx_credential_use`
  gates and audits each use under the instruction's lease (a revoked credential fails the payment closed before the
  provider is called);
- `cx_report_result` settles exactly as before and attributes the settlement journal to the instruction's venture
  (envelope venture, else the vendor destination's venture): venture → agent → wallet (ledger) → Treasury.

**PayPal payout signer.** OAuth client credentials from the vault → one single-item payout with
`PayPal-Request-Id = sender_batch_id = instructionId` (a retry returns the original batch, never a second payout).
`settled` only on SUCCESS with exactly the instructed amount and currency; `failed` only on a definitive refusal;
`pending` otherwise — including any outcome unknown after the request may have left. Pending payouts and their
leases persist in the custody state directory (0600) and are re-checked each tick; a claimed instruction older than
one hour is a doctor WARN (reconcile with the provider). Live mode is refused while `REAL_PAYMENTS_ENABLED` is not true.

**Doctor.** Custody facts come from `fleet_custody_status()`. Real-payment blockers are now exact: a living
self-keyed agent, and the absence of an attested live signer. The replication blocker (upstream children generate
their own key) stays. `fleet-verify-deployment.sh` also fails if any wallet/private-key file exists in founder state.

**Owner tooling.** `fleet:admin hub-custody`, `economy-custody-policy <ttlS>`,
`economy-destination-reference <destinationId> <reference>` (only the enrolled reference is accepted).

**Still pinned (unchanged).** `custody_execution_enabled` (v10 CHECK) and `fleet_payment_rails_not_live` (v29 CHECK):
no instruction can be issued in production. Activation remains a separate reviewed step: a migration lifting both
pins, `REAL_PAYMENTS_ENABLED=true`, the custody unit's egress opened to the provider API only, a custody state
directory, the owner's PayPal credential placed in the custody vault, a live rail registered, and the custody
executor's start-up refusal of `REAL_PAYMENTS_ENABLED=true` reviewed.
