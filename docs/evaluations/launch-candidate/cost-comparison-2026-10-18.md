# AI cost: the "30p" period against the failed run (2026-10-18)

Sources: `fleet_cognition_log` (one row per model call: model, tokens, cache, provider USD, ledger charge, payer and Anthropic's
message id) and Agent-1's own mind log (turns, steps, stops). **Fleet-recorded and PROVISIONAL until they are matched
with Anthropic's usage export.** Provider usage that does not match is unresolved; it is not assumed to come from
outside the Fleet. All times are UTC. Prices are those configured for tier T2 (claude-sonnet-5-5): input $2.00, cache
write $2.50, cache read $0.20 and output $10.00 per million tokens. These prices reproduce every period's recorded
cost exactly. Ledger: GBP at 0.749889 per USD (fx rate 73), each call rounded up to whole pence.

## The "earlier inexpensive test" is the start of the same run
The daily records since 2026-09-26 show no hour-long run of about 30p. The 27p reported to the owner at 12:47 was period A:
Agent-1 had already been looping for 5 minutes when the 20-calls-an-hour limit stopped it.

## Periods
| | A — "30p" | B | C |
|---|---|---|---|
| Window | resumed 12:26:41; calls 12:30:34–12:36:31; no calls 12:36:33–12:47:53 (hourly limit) | cap raised 12:47:53; calls 12:48:38–12:55:31; paused 12:55:29 | resumed 13:07:09; calls 13:07:36–13:11:02; paused 13:11:15 |
| Hourly limit | 20 | 600 | 600 |
| Runtime, model | f2a1784 (founder-v10), claude-sonnet-5-5 (T2) | same | same |
| Model calls: agent / treasury | 16 / 4 (your conversation turn) | 25 / 1 | 16 / 0 |
| Agent turns | 6 that thought (1 owner, 5 working); 3 refused "packet too large" (12:27–12:29, no call); 11 at the hourly limit (no call) | 7 (6 working, 1 owner) | 4 working |
| Tool actions (agent + owner) | 25 + 7 | 34 + 2 | 21 |
| Model time (sum of latencies) | 34.2 s + 19.0 s | 48.5 s + 2.8 s | 26.7 s |
| Agent tokens: uncached in / cache write / cache read / out | 109,988 / 0 / 544,112 / 2,645 | 208,851 / 34,007 / 782,161 / 4,436 | 143,942 / 34,007 / 476,098 / 1,381 |
| Retries, errors, interrupted requests | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| Agent cost (provider USD → ledger) | $0.3552 → £0.27 | $0.7035 → £0.53 | $0.4819 → £0.36 |
| Treasury (owner conversation) | $0.2531 → £0.18 | $0.0225 → £0.02 | — |
| Fleet Control (supervisor) calls | 0 | 0 | 0 |
| Development (Claude Code) | not in Fleet records: unknown | unknown | unknown |
| Per agent call | 2.22¢ | 2.81¢ | 3.01¢ |
| Useful work | 1 web search (demand evidence), 1 capability check; the owner turn ended with no reply | 1 reply to the owner (it named the blocker) | none |

Day total: 62 calls, $1.8162, £1.36 (agent £1.16, treasury £0.20).

## What caused the difference (established, quantified)
| Factor | Contribution | Evidence |
|---|---|---|
| **The loop ran longer**: the hourly limit raised from 20 to 600 | **All of B and C**: 41 agent calls, $1.1854 (£0.89). With the limit at 20, no call could run between 12:36 and about 13:31. It is not a multiplier on each call; it is how long the loop was allowed to run | turns 10–20 rate-limited; B and C ran only after the change |
| **Repeated orientation** (the 4-step cutoff, no closing note) | Nearly all of the agent's $1.54: every working turn was storefront/offer status, list_files ×2, read_file or exec, then a cutoff | mind log: 15 working turns of 2–4 steps; no product or offer |
| **Re-caching the fixed prefix after the pauses** (34,007 tokens: standing instructions + tool definitions; cache lifetime 5 minutes) | $0.085 in B and $0.085 in C ($0.17), +0.34¢ and +0.53¢ per call | cache_write 34,007 at 12:48 and 13:07 only |
| **Context growth within the run** (uncached input per call 6.9k → 8.4k → 9.0k) | ≈ $0.074 in B and $0.068 in C, against A's per-call rate | uncached per call |
| Model selection | **0**: Sonnet 5.5 throughout (Opus only on 26–30 September) | response_model |
| Output length | ≈ 0 (165 / 177 / 86 tokens per call) | output_tokens |
| Retries | 0 | outcome, attempts |
| Other Fleet callers | treasury-paid conversation turns $0.2756; Fleet Control $0 | payer |
| The 4 → 16 steps change | **0**: never deployed (71efd95 withdrawn) | release records |

Bound: the agent's own AI was limited by its daily fuse of 754p (≈ $10). At B/C's rate (8–11p a minute of working time),
the loop would have stopped at the fuse in about 1–1.5 hours. The treasury-paid conversation turns and anything outside
the Fleet are not under that fuse.

## Cost per call: where it goes
Per agent call today: ≈ 60% uncached input (the packet of about 15 KB plus each step's new tool results; only the fixed
prefix is cached in tier T2's "prefix" mode), 25–31% cache reads (the 34k prefix), 3–7% output, and the occasional
prefix re-cache. Context per call has grown from about 5.5k tokens (September, toolset-1/2) to 41k today. About 30k of
that is the toolset-6 tool definitions; the standing instructions are about 4.2k (measured).

## Remaining unknowns
- Matching with Anthropic's usage export (by message id `msg_…`); any unmatched usage stays unresolved until identified.
- Whether development or other work bills the same Anthropic account; your balance before and after.
- Tier T3's configured cache-read price (20 µ¢ per token, the same as Sonnet's): check it against Anthropic's Opus price.
  It affects accounting accuracy only; T3 made no calls today.
