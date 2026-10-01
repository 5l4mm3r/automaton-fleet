# R28 — F1-LIVE-01: controller + schema v25, legacy blocker import, Founder 1 (2026-10-01, VPS UTC)

Evidence: `pins.txt`, `r28-1-deploy.txt`, `import.json`, `owner-queue.json`, `owner-queue-after.json`,
`rehearsal.json`, `f1-preflight.json`, `f1-before.txt`, `f1-upgrade.json`, `f1-after.txt`,
`memory-report-{before,after}.json` and `doctor-after.txt`. They contain ids, digests, counts and status only. The
founder-written request `detail` is stripped. Everything was scanned clean.

## Release

- Commit `6764d78b68ea3d97ea78a91ce1a15fbc2a5adad8`.
- Build `cdbcffb9ea9b368b8eed9b633c126a8baf2a9c5a9b11b47eb9acd54b35894d11`, identical locally and on the VPS.
- Lockfile `eee9dc2f…` unchanged.

## R28-1 Controller `42dc14a` → `6764d78`, schema 24 → 25

- **Before:** `runtime.env.pre-r28` kept (the `42dc14a` pins).
- **Outage:** 16:38:56–16:39:10 (14 s), controller-side units only.
- **Pre-v25 dump:** `~/automaton_fleet-v24-pre-v25-20261001T163857Z.dump`, 2,940,283 B, mode 0600, sha256
  `70ababe0e265b603b167fb501e0418e721c7f09ba7d5125f5b31b318831b942d` (verified). `pg_restore -l` lists 90 tables with
  data and 588 functions.
- **Migration:** `migrate-check` exactly `{"currentVersion":24,"resultingVersion":25,"wouldApply":[25]}`. v25 applied at
  16:39:02; schema 25.
- **Then:** `audit-privileges` PASS; runtime approved; `fleet:verify-runtime` VERIFIED; `readyz` 200.
- **Checks:** doctor DEPLOYMENT OK, `fleet:verify` SAFE FOR DRY RUN, verify-deployment 149/0, ledger balanced, guard
  15/15, safety flags false.
- **Capability view** (live registry, deployed code): 27 tools, including the 5 experiment tools and the 2 owner-request
  tools; pipeline ON (simulated, hard cap 5,000, 3 active).
- **Founder 1 untouched:** PID 306862, pin, `facts.json` `bed022a8…`.

## Import of the legacy blocker (owner action; nothing decided)

Command: `owner-request-import 62cbe1b7-8642-4bf4-a6a7-b41c1dcc09e3 sales_channel blocking` at 16:40:00.

- **Imported record:**
  - request id = proposal id;
  - founder `01M3F50SH7PNX2E3GST13J52AS`;
  - created `2026-09-26T16:28:10.793Z`, the original submission time, so it was 5.0 d old and stale;
  - goal `g1` (from the proposal text), blocking, `pending`;
  - response none;
  - provenance `knowledge_proposal` / `operator:ubuntu`.
- **Nothing else changed:** payment orders, instructions, identity claims, experiments, the replication switch and the
  founder-v2 manifest are identical before and after. The knowledge proposal's record is byte-identical (md5
  `cde016f9…`), still `proposed` and marked `importedAsRequest`.
- **Idempotent by design:** UNIQUE(`source_ref`), UNIQUE(founder, idempotency key) and the function's replay path. It
  was not re-run in production. There was 1 import event and 0 decision events.
- **Doctor:** `owner requests` WARN (1 blocking request unanswered past 1.0 d; oldest 5.0 d). `institutional knowledge`
  WARN for the two other unreviewed proposals (the imported one is counted once).

## R28-2 Founder 1 `42dc14a` → `6764d78`

- **Before the upgrade:** rehearsal from `42dc14a` 24/24 (production unchanged, host clean); preflight `preflight_ok`.
- **Upgrade:** `b616ee79-161a-403d-b7b6-ce1c53ce34de`, verified 16:48:36; downtime 1.85 s; PID 306862 → 318932; state
  identical.
- **Unchanged:** identity `a8a7af56…`, credential `107ddfca…`, Genesis `8af1178c…`, ledger accounts `552ef792…`,
  `founder.json` `d8a8beb4…`, `facts.json` `bed022a8…` (facts-ledger still absent), population 1/0/0 cap 2, routing and
  safety switches.

## First natural wake (call 490, 16:49:08) and after

- **Full packet:** 14,487 B, 15,626 input tokens.
- **Capability record saved:** 27 tools, including `propose_experiment` and the rest of the pipeline,
  `request_owner_decision` and `withdraw_owner_request`.
- **The request was seen.** The founder's saved wake digest equals the digest of its state plus
  `caps:<sig>|req:62cbe1b7…:pending:1:2` (pending, blocking, stale milestone 2). It does not equal caps-only. The request
  line in the task and that signal come from the same request list.
- **The founder's decision:** it slept with the note "Gumroad 62cbe1b7 still pending; cash 9194p. Nothing new to act on;
  conserving inference. Next real check 2026-10-02T09:00Z." That is waiting with a stated reason, one of its options. No
  answer was invented, nothing was approved, and no tool or authority beyond the advertised set appeared.
- **Next natural wakes** (calls 491 at 16:51:10 and 492 at 16:54:13): **slim**, 3,273 / 3,283 B. The extra ~480 B over
  R27's 2,794 B is the stale owner-request line, which stays visible.

**Token overhead (slim idle wake):**

| | Total input tokens | Cost per wake |
|---|---|---|
| R27 uncached | 9,714 | 2,011,800 µ¢ |
| R28 (cached prefix + 1.39 k) | 10,366–10,372 | 543,980 µ¢ cached read |

That is about +655 tokens (+6.7 %): the two tool definitions (~450) plus the request line (~150). The uncached
equivalent is ≈ 2.16 M µ¢, about +7 %.

## After

- doctor DEPLOYMENT OK (expected WARNs only), `fleet:verify` SAFE FOR DRY RUN, verify-deployment 149/0, ledger balanced,
  runtime VERIFIED, guard 15/15, health challenges 7/7 passed.
- `memory-report`: 0 events, 14 legacy facts, parse ok.
- Safety: flags false; 0 orders, instructions, experiments and claims; replication off; 0 non-inference journals.

## Rollback (not needed)

- **Founder only:** `fleet-founders.sh rollback-runtime 01M3F50SH7PNX2E3GST13J52AS b616ee79-161a-403d-b7b6-ce1c53ce34de
  <reason…>` (`releases/42dc14a…` intact). The R28 controller and schema stay in place.
- **Controller / schema:**
  1. restore `runtime.env.pre-r28`;
  2. point `current` at `releases/42dc14a…`;
  3. restore the pre-v25 dump;
  4. verify schema 24, then re-verify.

  v24 code refuses a v25 database. A restore loses every row written after 16:38:57, including the imported
  `62cbe1b7` owner request and any later owner request or decision. The knowledge proposal itself is in the dump and
  survives.
