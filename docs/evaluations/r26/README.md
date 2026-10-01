# R26 — F1-FRESH-02 deploy: controller then Founder 1 (2026-10-01, VPS UTC)

Evidence: `pins.txt`, `r26-1-deploy.txt`, `rehearsal.json`, `f1-preflight.json`, `f1-before.txt`, `f1-upgrade.json`
and `f1-after.txt`. They contain digests, counts and ids only (no fact values or keys) and were scanned clean.

## R26-1 Controller `aabb297` → `64be9ce` (no schema change)

- **Build:** `fe22333a…4896` on the VPS, identical to the local prediction; lockfile `eee9dc2f…` unchanged.
- **Backups:** `runtime.env.pre-r26` kept (the `aabb297` pins). Dump `~/automaton_fleet-v24-pre-r26-20261001T102705Z.dump`
  (2,899,974 B, sha `220d8c60…`, 90 tables with data).
- **Migration:** `migrate-check` 24→24, nothing to apply.
- **Restart:** controller side only, 10:27:11–10:27:13 (`readyz` 200).
- **Checks:** doctor OK, `fleet:verify` SAFE FOR DRY RUN, `fleet-verify-deployment.sh` 149/0, ledger balanced, runtime
  VERIFIED, host guard 15/15.
- **Founder 1 untouched:** PID 283229, pin `aabb297`, `facts.json` `bed022a8…`.
- **Tools:** the founder now sees 18 tools, including `remember_facts` (`memory.private`). Manifest digest `30a70609…`
  is unchanged.

## R26-2 Founder 1 `aabb297` → `64be9ce`

- **Before the upgrade:** host rehearsal 24/24 (production unchanged, host clean); preflight `preflight_ok`.
- **Upgrade:** `fe249d9e-cc3c-497f-8597-989343929b81`, **verified 10:35:55**; downtime 1.77 s; PID 283229 → 301808; state
  identical.
- **Unchanged:** identity row `a8a7af56…`, credential row `107ddfca…`, Genesis `8af1178c…`, ledger accounts `552ef792…`,
  `founder.json` `d8a8beb4…`, population 1/0/0 cap 2, routing and safety switches.
- **Facts:** `facts.json` is byte-identical (`bed022a8…`). `facts-ledger.json` is still absent: no fact has been written
  since F1-FRESH-01.
- **`remember_facts` on a copy of the live memory**, run with the deployed release:
  - it wrote 2 facts;
  - the 14 legacy facts kept null metadata;
  - the packet had 0 problems;
  - the live memory was not written.
- **First natural wake** (call 470, 10:36:26, right after the restart):

  | | Before (calls 467–469) | After (call 470) |
  |---|---|---|
  | Packet | 2,783 B | 2,778 B (no regression) |
  | Input tokens | 9,298 | 9,708 (+410) |
  | Provider cost | 1,922,600 µ¢ | 2,011,600 µ¢ (+$0.00089 per idle wake, +4.6%) |

  The founder chose `sleep`, so `remember_facts` was not called.
- **After the wake:**
  - health challenges since the upgrade: 2/2 passed;
  - doctor OK, `fleet:verify` SAFE FOR DRY RUN, verify-deployment 149/0, ledger balanced, runtime VERIFIED, guard 15/15;
  - safety flags false; 0 payment orders.

## Rollback (not needed)

- **Founder:** `fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS fe249d9e-cc3c-497f-8597-989343929b81
  <reason…>` (`releases/aabb297…` intact).
- **Controller:** restore `runtime.env.pre-r26` and point `current` at `releases/aabb297…`. No migration is involved.
