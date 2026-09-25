# Genesis launch-readiness checklist (owner)

The fleet is technically ready to start two founders. What remains is the **owner's decisions**. Each
item says who acts, what is needed and how it is verified. Nothing here is performed by Claude,
ChatGPT or any agent. Every step marked **OWNER GATE** is refused by the database unless an owner
principal performs it.

State at the end of F.2: schema v13; Genesis **disabled**; population 0; cap 2; cognition **disabled**
(provider `none`); egress **closed**; real payments, replication and owner sweep **off**.

## A. Money (Phase E surface)

| # | Decision | How | Verify |
|---|---|---|---|
| A1 | Founder capital per founder (starting allocation, virtual until custody execution is enabled) | Decide the amount; it is recorded at `genesis-propose <2> <allocationCents>` | `genesis-status` shows it in the authorization hash |
| A2 | Record the real owner funding that backs it | `fleet:admin ledger-record-funding <cents> <bankRef>` (**OWNER GATE**; external reference required) | `ledger-verify` OK; treasury unallocated ≥ 2 × allocation |
| A3 | Prepaid inference credits (the fleet buys; founders reimburse from their own cash) | **Open engineering item.** Today a `conway_credits_purchase` is posted only by custody execution (disabled). Before launch, add a reviewed owner-only recorder (`fleet_admin_record_credits_purchase`, external reference required, owner source), or approve credits through the custody path | `fleet:conway_credits` balance; `ledger-verify` OK |
| A4 | Inference prices (microcents per input/output token), matching the provider's price list | Set on `cognition-enable` (`--in-microcents`, `--out-microcents`) | `cognition-policy` |
| A5 | Per-founder daily inference budget and hourly call limit | `founder-cognition <id> enable --daily-budget N --turns-per-hour N` | `cognition-status <id>` |

## B. Inference credential (Phase F.2 surface)

| # | Decision | How | Verify |
|---|---|---|---|
| B1 | Choose the provider and model (any OpenAI-compatible HTTPS endpoint) | Owner choice | — |
| B2 | Create a **dedicated, spend-capped** API key for the fleet only (provider-side hard limit) | At the provider | Provider dashboard |
| B3 | Install the key on the VPS: `/etc/automaton-fleet/cognition.key`, root:fleet 0600 → delivered to the controller only | Owner, over SSH (never in a chat, repository or ticket) | `fleet:doctor` founder cognition line; the key never appears in logs |
| B4 | Service configuration: `FLEET_COGNITION_PROVIDER=openai_compatible`, `FLEET_COGNITION_BASE_URL`, `FLEET_COGNITION_MODEL`, `FLEET_COGNITION_API_KEY_FILE` | Owner edits `service.env`, then restarts the controller | `service_started` log shows `cognitionProvider: openai_compatible:<model>` |
| B5 | Recommended hardening before B3: a per-exec sub-sandbox so a founder's shell cannot read its own credential file (see F.2 design §4, residual risks) | Engineering change + review | Tests |

## C. Egress (internet access for founders)

| # | Decision | How | Verify |
|---|---|---|---|
| C1 | Whether founders may reach the internet at all, and which hosts (exact names or `*.suffix`, 443 only) | Owner allow-list | — |
| C2 | Deploy the egress proxy (built in F.2, not deployed) as its own unit on loopback; widen the founder unit's `IPAddressAllow` **only** to the proxy; pass per-founder proxy credentials | Engineering change + owner approval (it changes network exposure) | Verify script; rehearsal probes: an allowed host works, a denied host, IP literal and metadata address are refused |
| C3 | Without C2 the founders can still think, plan, write and propose, but cannot research or sell online | — | — |

## D. Genesis (Phase F / F.1 surface)

| # | Step | Command | Gate |
|---|---|---|---|
| D1 | Enable Genesis | `fleet:admin genesis-enable <reason>` | **OWNER GATE** |
| D2 | Propose and approve two founders | `genesis-propose 2 <allocationCents>` → `genesis-approve <id> <authSha256>` | owner |
| D3 | Provision, attest and fund (virtual) | `sudo scripts/fleet-founders.sh provision / attest`, then `genesis-fund` | root tool + owner |
| D4 | Activate | `sudo scripts/fleet-founders.sh activate <id> <authSha256>` | **OWNER GATE** |
| D5 | Turn cognition on: the global switch, then each founder | `cognition-enable openai_compatible <model> ...`, then `founder-cognition <id> enable ...` | **OWNER GATE** |

## E. Monitoring and stopping

| What | How |
|---|---|
| Is each founder thinking, and what does it cost? | `fleet:admin cognition-status <id>`, `cognition-log <id>`, `ledger-economics <id>` |
| Stop one founder thinking now | `fleet:admin founder-cognition <id> pause <reason>` (next call refused) |
| Stop all thinking now | `fleet:admin cognition-disable` |
| Stop a founder entirely | `agent-hold <id> <reason>` (owner hold) or `mark-dead` (runtimes exit when refused) |
| Health | `fleet:doctor` (Genesis, founder cognition, founder runtimes), `fleet:verify`, `sudo scripts/fleet-verify-deployment.sh` |
| Spend orders from founders | `ledger-orders`; each needs policy and owner approval; custody execution stays disabled until the owner enables it |

## F. Still off after launch (unchanged)

Real payments / custody execution, replication and reseeding, owner sweep, fleet cap 2, and AI operator
authority (read-only). Each is a separate owner decision.
