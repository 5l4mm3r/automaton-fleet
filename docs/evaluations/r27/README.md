# R27 — F1-FRESH-02 memory observability: controller then Founder 1 (2026-10-01, VPS UTC)

Evidence: `pins.txt`, `r27-1-deploy.txt`, `rehearsal.json`, `f1-preflight.json`, `f1-before.txt`, `f1-upgrade.json`,
`f1-after.txt` and `memory-report-{before,after}.json`. They contain digests, counts, status and ids only, and were
scanned clean. Neither memory report contains a fact key or value.

## R27-1 Controller `64be9ce` → `42dc14a` (no schema change)

- **Build:** `6d426f45…2611` on the VPS, identical to the local build; lockfile `eee9dc2f…` unchanged.
- **Backups:** `runtime.env.pre-r27` kept (the `64be9ce` pins). Dump `~/automaton_fleet-v24-pre-r27-20261001T112804Z.dump`
  (2,908,312 B, sha `e7c22faf…`, 90 tables with data).
- **Migration:** `migrate-check` 24→24, nothing to apply.
- **Restart:** controller side only, 11:28:10–11:28:20 (`readyz` 200).
- **Checks:** doctor OK, `fleet:verify` SAFE FOR DRY RUN, verify-deployment 149/0, ledger balanced, runtime VERIFIED,
  guard 15/15.
- **Founder 1 untouched:** PID 301808, pin `64be9ce`, `facts.json` `bed022a8…`.
- **`memory-report`**, before the founder upgrade: 0 telemetry events (its runtime did not emit them yet). Fact store
  parses ok: 14 current facts, all legacy; no `facts-ledger.json`.

## R27-2 Founder 1 `64be9ce` → `42dc14a`

- **Before the upgrade:** rehearsal from `64be9ce` 24/24 (production unchanged, host clean); preflight `preflight_ok`.
- **Upgrade:** `647df17c-b19f-40eb-a1a0-fabf9ee387d4`, **verified 11:36:54**; downtime 1.77 s; PID 301808 → 306862;
  state identical.
- **Unchanged:** identity row `a8a7af56…`, credential row `107ddfca…`, Genesis `8af1178c…`, ledger accounts
  `552ef792…`, `founder.json` `d8a8beb4…`, population 1/0/0 cap 2, routing and safety switches.
- **Facts:** `facts.json` byte-identical (`bed022a8…`); `facts-ledger.json` absent (no memory write occurred).
- **First natural wake** (call 476, 11:37:25):

  | | Before (calls 474–475) | After (call 476) |
  |---|---|---|
  | Packet | 2,792 B | 2,790 B |
  | Input tokens | 9,714 | 9,714 (no change) |
  | Output tokens | 69 | 70 |
  | Cost | 2,011,800 µ¢ | 2,012,800 µ¢ (one output token) |

  The founder chose `sleep`. No memory operation occurred, so 0 `founder_memory_write` events is correct.
- **After the wake:**
  - health challenges since the upgrade: 2/2 passed;
  - doctor OK, `fleet:verify` SAFE FOR DRY RUN, verify-deployment 149/0, ledger balanced, runtime VERIFIED, guard 15/15;
  - safety flags false; 0 payment orders.
- **`memory-report` after:** journal ok; 0 events; `remember_facts` not used yet; fact store unchanged (14 legacy facts,
  parse ok).

## Rollback (not needed)

- **Founder:** `fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS 647df17c-b19f-40eb-a1a0-fabf9ee387d4
  <reason…>` (`releases/64be9ce…` intact).
- **Controller:** restore `runtime.env.pre-r27` and point `current` at `releases/64be9ce…`. No migration is involved.
