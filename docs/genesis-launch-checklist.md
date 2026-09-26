# Genesis launch-readiness checklist (owner)

The fleet is technically ready to start **one** founder (Genesis 0 → 1, schema v19). What remains is the **owner's decisions**. Each
item says who acts, what is needed and how it is verified. Nothing here is performed by Claude,
ChatGPT or any agent. Every step marked **OWNER GATE** is refused by the database unless an owner
principal performs it.

State before Genesis: schema v21 (GBP ledger, £100.00 native bootstrap capital, controlled USD→GBP FX, native-USD provider credit; founder charter v2 with the opportunity doctrine, see `docs/design/genesis-preparation-capital-doctrine.md`); Genesis **disabled**, and it creates exactly **one** founder
(`genesis_max_founders = 1`; the cap of 2 is a ceiling only; growth beyond one founder is to be earned later, and replacement
after a founder's death is a separate later process); population 0; cognition **disabled** (provider `none`); web research
deployed but **disabled**; real payments, custody, replication, reseeding and owner sweep **off**.

## A. Money (Phase E surface)

| # | Decision | How | Verify |
|---|---|---|---|
| A1 | Founder capital: **£100.00 GBP owner bootstrap capital, held natively** (v21: the ledger is GBP; Genesis binds GBP 10000 and allocates 10000 pence with no exchange rate; owner capital, never revenue or profit) | `genesis-bootstrap` shows it; change later with `genesis-bootstrap <CUR> <amount>` (**OWNER GATE**) | doctor "genesis bootstrap capital"; `genesis-status` → `capital` |
| A2 | Record the owner funding that backs it, in GBP pence | `fleet:admin ledger-record-funding 10000 <ref>` (**OWNER GATE**; recorded as `owner_funding`) | `ledger-verify` OK; treasury unallocated ≥ allocation |
| A3 | Record the REAL prepaid provider credit in its native USD (an operating resource, not founder capital) | `fleet:admin provider-credits-record anthropic purchase <USD, e.g. 19.97> <ref>` (**OWNER GATE**, v21); reconcile later with `… adjustment <±USD> <ref>` | `provider-credits anthropic` (USD balance and its GBP value at the current controlled rate) |
| A4 | Inference prices (microcents per input/output token), matching the provider's price list | Set on `cognition-enable` (`--in-microcents`, `--out-microcents`) | `cognition-policy` |
| A5 | Per-founder daily inference budget and hourly call limit | `founder-cognition <id> enable --daily-budget N --turns-per-hour N` | `cognition-status <id>` |

## B. Inference credential (Phase F.2 surface)

| # | Decision | How | Verify |
|---|---|---|---|
| B1 | Choose the provider and model (any OpenAI-compatible HTTPS endpoint) | Owner choice | — |
| B2 | Create a **dedicated, spend-capped** API key for the fleet only (provider-side hard limit) | At the provider | Provider dashboard |
| B3 | Install the key on the VPS: `/etc/automaton-fleet/cognition.key`, **0600 automaton-fleet-service:automaton-fleet-service** (the controller's own uid; every other unit has it in `InaccessiblePaths`) | Owner, over SSH (never in a chat, repository or ticket) | `fleet:doctor` founder cognition line; the key never appears in logs |
| B4 | Service configuration: `FLEET_COGNITION_PROVIDER=openai_compatible`, `FLEET_COGNITION_BASE_URL`, `FLEET_COGNITION_MODEL`, `FLEET_COGNITION_API_KEY_FILE`; optional `FLEET_COGNITION_MAX_TOKENS_PARAM` (`max_tokens`/`max_completion_tokens`), `FLEET_COGNITION_ATTEMPT_TIMEOUT_MS` (90 s), `FLEET_COGNITION_DEADLINE_MS` (120 s), `FLEET_COGNITION_MAX_ATTEMPTS` (3) | Owner edits `service.env`, then restarts the controller | `service_started` log shows `cognitionProvider: openai_compatible:<model>` |
| B4-anthropic | **Chosen route (step 2.1): native Anthropic.** `FLEET_COGNITION_PROVIDER=anthropic`, `FLEET_COGNITION_MODEL=<verified model id>`, `FLEET_COGNITION_API_KEY_FILE=/etc/automaton-fleet/cognition.key`; optional `FLEET_COGNITION_BASE_URL` (default `https://api.anthropic.com/v1`), `FLEET_COGNITION_THINKING` (`adaptive` \| `enabled:<N>`; unset = model default), `FLEET_COGNITION_EFFORT` (`low`…`max`), `FLEET_COGNITION_ANTHROPIC_VERSION`, `FLEET_COGNITION_ATTEMPT_TIMEOUT_MS`/`DEADLINE_MS` (tier A: 150000/180000). Registry: `cognition-enable anthropic <same model> --max-output 4000 --in-microcents <p> --out-microcents <p> [--cache-write-microcents <p> --cache-read-microcents <p>] --turns-per-hour 20 --daily-budget <¢>` | Owner, after verifying the model id and prices | Probe P1–P11 |
| B4a | **Provider probe (L14)**, before Genesis and before `cognition-enable` | `sudo scripts/fleet-cognition-probe.sh --prices <in>,<out>` | `L14 PROVIDER PROBE: PASS` (P1–P7); no founder, no ledger, no key printed |
| B5 | ~~Per-exec sandbox~~ **Done in F.3**: every founder shell command runs in a Landlock domain (workspace only; credential/state unreadable; no TCP; fail closed) | — | Rehearsal check "the founder's shell runs in its Landlock sandbox" |

## C. Egress (internet access for founders)

| # | Decision | How | Verify |
|---|---|---|---|
| C1 | Founders reach the Internet only through FleetController's `web_fetch` (capability `research.web`, manifest founder-v2): HTTPS GET to public addresses, through the isolated fetcher (step 4, schema v18; `docs/design/pre-genesis-web-research.md`). Founder shells stay network-less | Deployed; **research disabled** | `research-policy` → `enabled false`; `fleet-verify-deployment.sh` "Research fetcher isolation" section |
| C2 | Quotas: per founder 60/h, 300/day; fleet 120/h, 600/day (defaults; tighter per founder with `founder-research`) | `research-enable [--founder-hourly N --founder-daily N --fleet-hourly N --fleet-daily N]` | **OWNER GATE**; `research-policy` |
| C3 | Stop research at once (all founders, or one) | `research-disable`; `founder-research <id> pause <reason…>` | `research-log` shows `FLEET_RESEARCH_DISABLED` / `_PAUSED` refusals |

## D. Genesis (Phase F / F.1 surface)

| # | Step | Command | Gate |
|---|---|---|---|
| D1 | Enable Genesis | `fleet:admin genesis-enable <reason>` | **OWNER GATE** |
| D2 | Propose and approve the one founder (any other count, and any allocation other than the bootstrap capital, is refused by the registry) | `genesis-propose 1` (no rate: GBP capital in the GBP ledger) → check `capital` and `allocationCents` (10000) → `genesis-approve <id> <authSha256>` | owner |
| D3 | Provision, attest and fund (virtual) | `sudo scripts/fleet-founders.sh provision / attest`, then `genesis-fund` | root tool + owner |
| D4 | Activate | `sudo scripts/fleet-founders.sh activate <id> <authSha256>` | **OWNER GATE** |
| D5 | Turn cognition on: the global switch, then the founder | `cognition-enable anthropic <model> ...` (B4-anthropic), then `founder-cognition <id> enable ...` | **OWNER GATE** |

## E. Monitoring and stopping

| What | How |
|---|---|
| Is each founder thinking, and what does it cost? | `fleet:admin founders-report` (all founders: cash, cognition, 24 h usage, refused forbidden requests, orders awaiting you); `cognition-status <id>`, `cognition-log <id>`, `ledger-economics <id>`; doctor warns on budget pressure and forbidden-tool requests |
| Stop one founder thinking now | `fleet:admin founder-cognition <id> pause <reason>` (next call refused) |
| Stop all thinking now | `fleet:admin cognition-disable` |
| Stop a founder entirely | `agent-hold <id> <reason>` (owner hold) or `mark-dead` (runtimes exit when refused) |
| Health | `fleet:doctor` (Genesis, founder cognition, founder runtimes), `fleet:verify`, `sudo scripts/fleet-verify-deployment.sh` |
| Spend orders from founders | `ledger-orders`; each needs policy and owner approval; custody execution stays disabled until the owner enables it |

## F. Still off after launch (unchanged)

Real payments / custody execution, replication and reseeding, owner sweep, fleet cap 2, and AI operator
authority (read-only). Each is a separate owner decision.
