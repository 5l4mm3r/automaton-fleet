# R23 — v23 controller deploy, host rehearsal and Founder 1 runtime upgrade (2026-09-30, VPS UTC)

Evidence files (digests, counts and ids only — no credential, token or key; scanned): `aab6ca3-pins.txt`,
`cutover.txt`, `rehearsal.json`, `f1-status.json`, `f1-preflight.json`, `f1-before.txt`, `f1-upgrade.json`,
`f1-after.txt` (37 s after the upgrade), `f1-after2.txt` (3 min after).

## R23-1 Controller release `aab6ca3`, schema v23
- Build `2a0a324c25d90be3b4cb631136284f734c0f2394a30d708384bd8a19fa1dab01`, lockfile `eee9dc2f…` unchanged; the VPS
  build and the local clean build are identical. `runtime.env.pre-r23` kept (`b8e8e9a` pins, sha `3ca78311…`).
- Controller-only outage **13:19:09–13:19:20 (11 s)**: Operator API, ChatGPT adapter (socket + service), custody,
  fetcher (socket + service) and controller stopped; dump `~/automaton_fleet-v22-pre-v23-20260930T131909Z.dump`
  (2,338,178 B, sha `e7f3c44a…097e`, 0600, 78 tables with data); `migrate-check` exactly `{22→23, wouldApply:[23]}`;
  v23 applied 13:19:13; audit PASS; `approve-runtime`; runtime VERIFIED; units started.
- After: doctor OK, `fleet:verify` 16/16 SAFE FOR DRY RUN YES, `fleet-verify-deployment.sh` 148/0. **Founder 1 not
  touched** (PID 185890, 0 restarts, pin `eea1932`, `founder.json` sha `d8a8beb4…`).

## R23-2 Rehearsal on the host (13:20–13:24)
`fleet-founders.sh upgrade-rehearsal eea1932…`: real systemd founder units, throwaway registry, fake provider.
**23/23 checks pass**; production snapshot unchanged, host clean, Founder 1's PID untouched. Covered: abort on a state
change while stopped; a mis-pinned runtime refusing to start (exit 4) and automatic rollback (3.5 s downtime);
upgrade (1.8 s); rollback of a verified upgrade; re-upgrade; routed T1/T2/T3 with escalation, action linkage and the
cache policy (T2: 1 prefix write, 3 reads; T1 and the T3 question: no cache marker); 0 protocol violations.

## R23-3 / R23-4 Founder 1 (`01M3F50SH7PNX2E3GST13J52AS`)
Preflight 13:25:18 `preflight_ok`. Upgrade `3ae01f74-5db4-4dbb-a237-4504ff7b5df3`, **verified 13:26:20**:

| | Before | After |
|---|---|---|
| Runtime (registry = host pin = process) | `eea1932` / build `40536771…927c` | `aab6ca3` / build `2a0a324c…dab01` |
| Process | PID 185890, uid 65037 | PID 253900, uid 65037 |
| Durable state sha256 (25 files) | `dfdd470c7b41e08f…be83a12b` | identical at stop, at start and after verification |
| `founder.json` sha256 | `d8a8beb418409def…4db11517` | identical |
| Credential file / registry credential row | sha `f25654ba…` / `107ddfca…` | identical |
| Registry identity row, Genesis record + attestation, ledger accounts | `a8a7af56…`, `8af1178c…`, `552ef792…` | identical |
| Books | cash 9334p + expense 666p, 377 journals | 9328p + 672p after 3 legacy calls (6p); always 10000p; ledger verifies |
| Population / agents / Genesis records | 1 / 1 / 1 | 1 / 1 / 1 |

- Downtime 1.8 s (stop 13:26:18.47 → health proof 13:26:20.24). Health: heartbeat and 1 challenge passed at the switch,
  4 passed / 0 failed within 3 min; lifetime 5,611 passed, 0 failed.
- Backup `/var/lib/automaton-fleet-upgrades/3ae01f74-…` root:root 0700, 24 files, no credential.
- The upgraded founder kept thinking on the legacy path (Opus 5.5, tier NULL): routing OFF, 0 founders opted in, all
  tiers disabled and unverified. Its first post-upgrade turns changed only `facts.json`, `mind-history.json` and
  `mind-log.jsonl` (its own work).
- Rollback path: `releases/eea1932…` still hashes to build `40536771…`; the upgrade is the founder's latest, so
  `fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS 3ae01f74-5db4-4dbb-a237-4504ff7b5df3 <reason…>` applies.
- After: `fleet:verify` 16/16, `fleet-verify-deployment.sh` 149/0 (pin = registered release `aab6ca3`, no open upgrade,
  backups root-only), runtime VERIFIED. Leak scan of receipts, logs, journals, events, upgrade records and the backup: 0.

## Not done (owner commands)
`cognition-tier-verify`, `cognition-tier-enable`, `cognition-routing-enable`, `founder-routing` — see runbook "Stage R23", R23-6.

## R23-6 First natural routed call after the owner cutover (evidence: `routed-first-calls.txt`)
Owner cutover 17:09–17:14 (tiers verified + enabled, routing on, Founder 1 opted in). No cognition was forced: Founder 1
was in its maximum idle backoff (sleep-only turns every ~33 min) and its next natural turn came at 17:34:40.

| Call | Tier / model | Route | Tokens in (uncached / cache write / read) | Out | Cost | Result |
|---|---|---|---|---|---|---|
| 430, 17:34:40 | T2 / claude-sonnet-5-5 | agent_step, class_minimum, task_step | 6,817 / 4,767 / 0 | 90 | 2,645,150 µ¢ ($0.0265); charged 1,996,806 µp | ok, 1 attempt, `sleep` |

- Task packet 14,255 B as the only message (no transcript replay); cache policy `prefix` ("T2 stable prefix: reuse
  expected"); no provider error, no refusal, no legacy call after the cutover; routing counters in the runtime
  report: 1 routed turn, 1 T2 step.
- Health: 22 challenges passed, 0 failed since the cutover; still `aab6ca3`, PID 253900. Books: cash 9274p +
  expense 726p = 10000p = allocation, equal to the sum of all charges; ledger verifies (411 journals). Identity and
  credential files unchanged; `goals.json` unchanged; `facts.json` has changed since the upgrade (the founder's own
  writes); continuity note written.
- **Finding (economics, not safety):** for an idle wake-up that only sleeps, the routed T2 call cost **+33%** versus the
  legacy Opus idle turns it replaced (1,994,800 µ¢ each at 15:55/16:28/17:01). Two causes: (1) the task packet
  (~3.6k tokens) is larger than the legacy idle history, so input went from ~4.5k to ~11.6k tokens; (2) the T2 prefix
  was written (premium −238,350 µ¢) but a one-step turn followed by a 33-minute sleep never reads it back.
  Candidate refinement (not deployed): cache the T2 prefix only when reuse is evidenced (inside a tool loop, or the
  founder's previous call within the cache lifetime), as T3 task steps already do; and a slimmer packet for a bare
  wake-up. Absolute impact at the current idle cadence ≈ +$0.3/day.

## R23.1 controller-only (`4821616`, 18:00) — first natural idle wake vs call 430 (evidence: `r231-first-idle-wake.txt`)
| | Call 430 (17:34:40, before) | Call 431 (18:07:47, after) | Change |
|---|---|---|---|
| Tier / model / outcome | T2 Sonnet 5.5, ok, 1 attempt | T2 Sonnet 5.5, ok, 1 attempt | same (classification unchanged) |
| Cache policy | `prefix` ("reuse expected") | `off` ("T2 no evidenced reuse") | — |
| Packet bytes | 14,255 | 14,326 | slim packet not active on Founder 1 (runs `aab6ca3`) |
| Input tokens uncached / cache write / read | 6,817 / 4,767 / 0 | 11,638 / 0 / 0 | write premium gone |
| Output tokens | 90 | 89 | — |
| Provider cost (USD µ¢) | 2,645,150 | 2,416,600 | **−228,550 (−8.6%)** |
| Founder charge (GBP µp) | 1,996,806 | 1,818,847 | **−177,959 (−8.9%)** |

- Provider-credit balance fell by exactly 2,416,600 µ¢ (call 431's cost); books cash 9272p + expense 728p = 10000p =
  sum of charges; ledger verifies. Founder 1 PID 253900 (not restarted), 55 challenges passed / 0 failed since the
  cutover; identity, credential, Genesis, ledger accounts, switches unchanged; only its mind log and continuity note changed.
- Still +21% vs the legacy Opus idle turn (1,994,800 µ¢): the rest is packet size, which the slim wake-up packet
  (pending on Founder 1) addresses.
