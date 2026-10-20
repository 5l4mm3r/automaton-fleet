# Release 014f6d4 (schema 103 → 104; UI 0.26.2 unchanged) + Agent-1 runtime 8bd8a3e → 014f6d4 — INSTALLED 2026-10-20 17:37Z (supersedes the staged 093a2c0)

Contains 093a2c0 (customer money checks, cost-bounded reservations, the rerun's all-in maximum and spend circuit breaker —
release-093a2c0.md) plus the owner's three targeted checks:

| Check | Result |
|---|---|
| 1. The spend circuit breaker vs the agent's refund | the breaker is checked only by purchase paths (fleet_spend_request_core, envelope spend). PostgreSQL proof of the rerun's combination: breaker tripped → a purchase rejected (FLEET_INFRASTRUCTURE_CIRCUIT_BREAKER), agent cash unchanged; the agent's £5 refund under the order-only authority sent and completed with the breaker still tripped |
| 2. No fixed stop threshold | v104: a request whose reservation does not fit the open run is refused with exactly what it reserves and what is left (spent, in flight); the controller brings the run's end time forward to now through one named writer (fleet_cognition_run_end_unfit) — never ended_at, which would leave later requests uncapped; later requests are refused as ended. The watchdog reports that reason. The rerun requires Agent-1's requests to be routed (only they carry the bound and the run check) and stops if they stop being routed. The "at least 374p available" claim is withdrawn |
| 3. Every billable component in the bound; overruns visible | the reservation counts: system prompt, every message (tool results and returned thinking blocks included) and the full tool definitions as UTF-8 bytes (one token ≥ one byte), images at the provider maximum (1,600), 2,000 framing tokens, all at the dearer of input / 5-minute cache-write price (the gateway requests the default ephemeral cache), plus the whole output allowance — thinking is output and within it — at the output price. Cost is computed from the tier table's list prices (Fleet-recorded; reconciled later against the provider console). Any call that still cost more than it reserved stops the run with the difference on record; the report shows credit drawn, charges and overruns separately (the earlier proof: 62 calls, 193.7822p drawn, 192.1332p charged, 4 over by 1.6489p) |

Also: `proof.sh test-funding <txnId>` records the owner's test deposit as OWNER FUNDING of exactly its verified net (PayPal's
own transaction record: completed, GBP, unclaimed) and attributes it; proven in PostgreSQL (once; a second record or
attribution is refused). It is not backing for the agents' £200 and does not make the Fleet launch-ready.

| Item | Result |
|---|---|
| Pins | commit 014f6d4c60628f64a959310e384b3acb33d15413 · build e56e878bfa21743ef5291f9043e3282464a53c7c0acdc935fc2518d6e8b7799d · lockfile 1df54e35… — VPS = local |
| Tests | v96 (8), v94 (6), proof script (17), money checks (6), routing-pg / v62 / v100 / v95 (42) — pass |
| Rehearsals 103 → 104 | data PASSED 17:13:29Z; services PASSED 17:14:00Z |
| Install | deployed 17:15:57Z; founder upgrade rehearsal from 8bd8a3e 27/27; revision rehearsal 14/14 (real units); Agent-1 upgrade 432410f9-3de1-4907-a0af-8f88815922e8; verify VERIFIED 17:38:08Z; both agents paused; the proof unchanged |

## Arithmetic checker — documented limits (unchanged)
Checked before sending: written calculations, itemised lists with a total, and labelled totals against the record. NOT
checked: amounts in words or other currencies, arithmetic implied in prose, document / PDF / image contents, channel posts
and browser actions. Spreadsheets: recalculation by two engines and acceptance cases (a missing case is a warning).
