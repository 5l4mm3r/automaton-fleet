# R24 — experiment pipeline deploy and Founder 1 runtime upgrade (2026-09-30, VPS UTC)

Evidence files contain digests, counts and ids only: no credential, token or key. All files were scanned for
secret-shaped content and are clean.

- **Rehearsals and receipt:** `migration-rehearsal.txt` (local v23→v24, four runs); `simulated-experiment-receipt.json`
  (local, simulated).
- **Deploy:** `pins.txt` (VPS build of `59896ce`); `cutover.txt` (R24-1 controller cutover).
- **Upgrade:** `rehearsal.json` (R24-2 host rehearsal), `f1-status.json`, `f1-preflight.json`, `f1-before.txt`,
  `f1-upgrade.json`, `f1-after.txt`.
- **Idle wakes:** `f1-idle-wakes.txt` (calls 430–440, health, books, pipeline state).

## R24-1 Controller release `59896ce`, schema v24 (pipeline OFF)
- Build `301133b5…d0b5`, identical to the local prediction; lockfile `eee9dc2f…` unchanged. `runtime.env.pre-r24`
  kept (`4821616` pins).
- Controller-only outage 20:16:32–20:16:44 (12 s). Dump `~/automaton_fleet-v23-pre-v24-20260930T201632Z.dump` (sha
  `f2c8d314…`).
- `migrate-check` exactly `{23→24, wouldApply:[24]}`; audit PASS; runtime VERIFIED.
- Checks: doctor DEPLOYMENT OK, `fleet:verify` 16/16, `fleet-verify-deployment.sh` 149/0, ledger verifies. Founder 1
  was not touched.

## R24-2 Founder 1 runtime upgrade `aab6ca3` → `59896ce`
- **Host rehearsal** 20:24–20:32: 24/24 checks; production unchanged, host clean, Founder 1's PID untouched.
- **Preflight:** `preflight_ok`, 26 state files, no open upgrade.
- **Upgrade** `9315b1f0-9cba-404a-8c0d-a6b0a7667e5c`, **verified 20:32:16**. Downtime 1.76 s; PID 253900 → 270844,
  uid 65037.
- **State:** durable state sha `508369ee…c1d6` identical at stop, at start and after (compare: "state identical").
  `founder.json` sha `d8a8beb4…` and credential file sha `f25654ba…` are unchanged.
- **Registry, unchanged before → after:** identity row `a8a7af56…`, credential row `107ddfca…`, Genesis `8af1178c…`,
  ledger accounts `552ef792…`, population 1/0/0, routing switches, `runtime.env` safety flags.
- **Pins:** registry runtime = host pin = process working directory = `59896ce` / build `301133b5…`.
- **Books:** continuous; always 10,000p (cash 9261 + expense 739 at 20:52), ledger verifies.
- **Health:** heartbeating, 21 challenges passed and 0 failed in the first 20 minutes, 0 restarts.
- **Routing:** still active (routing on, founder opted in, T1/T2/T3 verified and enabled).
- **Pipeline:** experiment-policy `enabled:false`; 0 experiments, 0 evidence artifacts, 0 relevance calls; no
  `experiment_*` audit event.
- **Experiment tools:** not sent to the model while the pipeline is off. The routed gateway sends them only when
  `experimentsEnabled === true` (test in `fleet-cognition-routing.test.ts`), and the controller reports false.

## Slim wake packet: active
The first turn on the new runtime (436, 20:32:47) sent a full packet: the previous runtime never recorded a wake
digest. Every idle wake since then (turns 2–5, calls 437–440) sent the slim packet.

| Call | Packet | Input tok | Output tok | Cache | Provider cost (USD µ¢) | Charged (µp) |
|---|---|---|---|---|---|---|
| 430 (full, old runtime) | 14,255 B | 6,817 (+4,767 cache write) | 90 | prefix write | 2,645,150 | 1,996,806 |
| 431 (full, old runtime) | 14,326 B | 11,638 | 89 | off | 2,416,600 | 1,818,847 |
| 437 (slim, 2 min after start) | 2,813 B | 1,221 (+4,767 cache write) | 87 | prefix write | 1,522,950 | 1,146,244 |
| 438 (slim, 3 min gap) | 2,812 B | 1,218 (+4,767 cache read) | 78 | prefix read | 416,940 | 313,809 |
| **440 (slim, 9 min gap, cold)** | **2,804 B** | **5,976** | **78** | **off** | **1,273,200** | **958,271** |

**Like-for-like, 440 vs 431** (both cache off, sleep-only idle wake): packet −80%, input tokens −49%, provider cost
−47%, charge −47%. Against 430, cost is −52%.

The remaining ~4.8k input tokens are the fixed charter and tool prefix, now the bulk of an idle turn.

**Cadence note:** the idle backoff lives in the founder's memory and resets on restart. It stretches to the ~33-minute
cadence again within about an hour (1, 2, 4, 8, 16 then 32 thinking slots). The short early gaps are why 437–439 fell
inside the 5-minute cache window.
