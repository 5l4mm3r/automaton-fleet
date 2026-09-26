# Genesis preparation: £100 bootstrap capital and the opportunity doctrine (schema v20)

Owner and architect decisions for Founder 1, encoded with minimal changes. No founder exists yet, and Genesis,
cognition, research, custody, payments, trading, reproduction and reseeding are all off.

## 1. Bootstrap capital: £100.00

- **Currency.** The ledger is USD-only by constitution: v10 stores integer USD cents, and inference is billed
  in USD. The owner's decision is recorded in its own currency:
  - `fleet_genesis_policy.bootstrap_capital_currency = 'GBP'`
  - `bootstrap_capital_minor = 10000` (£100.00 per founder)
- **Changing it.** This is policy, not a constant. `genesis-bootstrap <CUR> <amount>` changes it for future
  Geneses, through the owner-only `fleet_genesis_set_bootstrap`.
- **Conversion.** At Genesis the owner states a fresh GBP→USD rate: `genesis-propose 1 --fx <USD per GBP>
  --fx-source <where it came from> [--fx-at ISO]`.
  - The registry refuses a rate observed more than 24 h before the proposal.
  - It derives `allocation_cents = floor(10000 × rate)`, which never exceeds what £100 buys.
  - It binds the currency, amount, rate, source and observation time into the authorization hash the owner
    approves.
  - Those fields are frozen afterwards.
  - While a capital decision exists, the plain-USD proposal path is refused. Nothing invents a rate.
- **Classification (unchanged, and verified by the dry run and rehearsal).**
  - The owner's contribution is recorded as `owner_funding` into the treasury.
  - It reaches the founder as `genesis_allocation`.
  - External customer revenue, realized net profit and LFC stay 0.
  - The Genesis view labels it `owner_bootstrap_capital`.
  - It is never profit and never counts towards reproduction eligibility.
- **Governance.** The founder has no custody and no payment credentials. The £100 is one pool governed
  dynamically by the existing mechanisms (allocation, runway, spend orders, survival and risk), not
  pre-split into buckets.

## 2. Opportunity doctrine (charter v2)

`FOUNDER_CHARTER` (`founder-charter-v2`) gives economic priors, not a business:
- **Search:** actively look for legitimate revenue.
- **Where to look:** favour capital-efficient opportunities with AI leverage.
- **What to weigh:** cost, time-to-cash, margin, reversibility, demand evidence, scalability and downside.
- **Capital:** preserve runway; do not spend capital on infrastructure before demand is validated; find
  lower-capital ways into attractive fields; validate cheaply first.
- **Judgement:** high risk is not low opportunity, and history does not guarantee the future.
- **Current information:** research current information through `web_fetch`, including markets, stocks and
  crypto.
- **Evidence:** cite the research `attemptId` when using evidence.
- **Authority:** research is not trading authority.
- **Capital classification:** the starting allocation is owner capital, not profit, and the ledger (not the
  founder) decides performance and eligibility.
- **Honesty:** never fabricate evidence, customers, revenue, market data or credentials.
- **Knowledge:** keep compact conclusions, and propose validated lessons, failures included.

The charter is about 800 tokens and is paid on every call. It carries no amount: the ledger does.

## 3. Current research and financial markets

- **Path.** The existing `research.web` path is unchanged: founder → FleetController → quotas/audit →
  isolated fetcher → public HTTPS. Founder shells stay networkless, and research stays **off** until the
  owner runs `research-enable`.
- **Markets.** Market topics are not filtered: stocks, crypto and news are legitimate research. Execution
  is impossible, for these reasons:
  - there is no trading tool;
  - custody execution is off;
  - payments are off;
  - reproduction execution is constitutionally off;
  - the founder holds no keys.

## 4. Evidence-aware capital decisions (compatible, not built)

- **Today.** Every research fetch has a stable `attemptId` and controller-held provenance: URL, final URL,
  fetch time, status and SHA-256. It sits in the append-only `fleet_research_attempts/results`. The
  founder sees the `attemptId` and is told to cite it in spend requests and knowledge proposals.
- **Later.** A future capital assessment can join a request to its evidence and re-fetch it to check
  freshness. It can then weigh the dimensions the owner listed as separate axes: evidence strength and
  freshness, upside, downside, requested capital, runway, reversibility, time sensitivity, liquidity,
  prior fleet evidence, confidence and treasury health. Risk is not collapsed into "reject".
- **Not built now:**
  - a structured `evidence[]` field on spend orders;
  - a scoring engine.
- **Unchanged:** every existing financial control (owner approval thresholds, daily spend, reservations
  and custody off).

## 5. Data lifecycle (HOT / WARM / COLD)

| Tier | Now | Later |
|---|---|---|
| HOT: raw pages and signals | Saved pages in the founder workspace are pruned to the newest 100 (`pruneResearch`). The controller never stores page content. | TTL, dedupe and aggregation of collected signals |
| WARM: hypotheses and experiments | Founder goals, private memory and workspace notes | Controller-tracked opportunities and experiments with expiry |
| COLD: validated lessons and failures | `fleet_knowledge_proposals` → owner review → `fleet_knowledge_entries` (compact, with provenance) | Strategy registry fed from ledger-derived outcomes |

The research audit keeps metadata only (no bodies), bounded by quotas. Compacting it after its audit window
is a later task.

## 6. Institutional learning

Agents can propose lessons (`propose_knowledge`), and the owner promotes them. Replacement founders can read
the promoted knowledge (`read_knowledge`). They get no private chain of thought, personality or private
state. Agents cannot set any of the following themselves: performance truth, realized profit, strategy
confidence, reproduction eligibility, risk evidence or FleetController policy. These remain ledger- and
controller-derived. Automatic replacement (reseeding) stays disabled, and the strategy registry is not
built.
