# R25 — F1-FRESH-01 deploy: controller then Founder 1 (2026-10-01, VPS UTC)

Evidence (digests, counts and ids only; no fact values or keys; scanned clean): `pins.txt`, `r25-1-deploy.txt`,
`rehearsal.json`, `f1-preflight.json`, `f1-before.txt`, `f1-upgrade.json`, `f1-after.txt`.

## R25-1 Controller `aabb297` (no schema change)
- Build `bb3fd917…dc17`, identical to the local prediction; lockfile `eee9dc2f…` unchanged. `runtime.env.pre-r25`
  kept (`59896ce` pins).
- Dump `~/automaton_fleet-v24-pre-r25-*.dump` (2,837,766 B, sha `7f77b5c8…`, 90 tables with data).
- `migrate-check` 24→24, nothing to apply. Controller-side restart 00:04:44–00:04:54 (10 s).
- Checks: doctor OK, `fleet:verify` SAFE FOR DRY RUN, `fleet-verify-deployment.sh` 149/0, ledger balanced, runtime
  VERIFIED, host guard 15/15.
- Founder 1 untouched (PID 270844, pin `59896ce`, `facts.json` sha `bed022a8…`, no `facts-ledger.json`).
- The deployed code exposes `remember_fact(key, value, source, supersedes)`, `retract_fact(key, reason)` and
  `recall_facts(query, includeHistory)`. Its packet validator accepts a packet with `observedAt`/`provenance`
  (0 problems); a superseded fact is absent from that packet.

## R25-2 Founder 1 `59896ce` → `aabb297`
- Host rehearsal 24/24 (production unchanged, host clean). Preflight `preflight_ok`.
- Upgrade `86c6ec8d-eb1b-4048-a05b-91e50b0d3cd2` **verified 00:13:38**; downtime 1.72 s; PID 270844 → 283229; state
  identical.
- Unchanged: identity row `a8a7af56…`, credential row `107ddfca…`, Genesis `8af1178c…`, ledger accounts `552ef792…`,
  `founder.json` `d8a8beb4…`, population, routing and safety switches.
- **Facts:** `facts.json` byte-identical before, right after and after the first wake (`bed022a8…`).
  `facts-ledger.json` absent: no fact has been written since; it appears on the first legitimate write.
- On a copy of the live memory, the deployed code loads the 14 legacy facts with null metadata (14/14) and nothing
  in history. `possiblyStale` 0: the only goal (g1) is open.
- **First wake** (call 447, slim packet): 2,802 B (no packet regression); input 9,312 vs 8,946 tokens (+366);
  provider cost 1,940,400 vs 1,867,200 µ¢ (+3.9%, +$0.00073 per idle wake).
- After: doctor OK, `fleet:verify` SAFE FOR DRY RUN, verify-deployment 149/0, ledger balanced, runtime VERIFIED,
  guard 15/15, health challenges passing.
- Rollback: `fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS 86c6ec8d-eb1b-4048-a05b-91e50b0d3cd2
  <reason…>` (`releases/59896ce…` intact); controller: `runtime.env.pre-r25` + `current` → `releases/59896ce…`
  (no migration involved).
