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
