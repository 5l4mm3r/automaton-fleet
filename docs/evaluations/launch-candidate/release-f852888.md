# Release package — f852888 (schema 61 → 62, dashboard 0.13.0): owner ↔ agent conversations, customisable names, treasury-paid owner turns, event-driven hibernation

Prepared and rehearsed 2026-10-10; **DEPLOYED 2026-10-10 16:08:28Z** on the owner's authorization (see the end). Before it, production was `b0ac910`, schema 61, UI 0.12.1; both agents run
`fda78a0` and are **paused** (since 12:37Z; no AI call after 12:19:54Z). Supersedes the 3b456cd build in `~/rlc62`:
do not cut over from it. The specification and its acceptance matrix are in
`docs/design/owner-replies-and-plain-language.md` (revision 2).

No live flag, cap, operating mode, economic policy or approved runtime changes. The four safety flags stay false;
setup protection stays on; custody execution stays off.

## Contents

| Commit | What |
|---|---|
| 0b031ee | UI 0.12.2: plain-language pass, "Awaiting reply", customisable PayPal key names, design |
| 3b456cd | schema v62 + UI 0.13.0: conversations (messages, files, replies, requests and card approvals in one thread), names (200 characters, Unicode / emoji, duplicates tagged, unsafe characters refused; key and payment-account names are labels only), treasury-paid owner turns (`owner_conversation_charge`), Mind panel, P3_INFO → P3_SUMMARY fix plus a one-time backfill; runtime: `reply_to_owner`, attention wake-ups, event-driven hibernation |
| f852888 | validation fixes: the scripted rehearsal model keeps the v5 close within the five-call limit; four tests updated to v62 routing and hibernation; a ledger test's false positive (a UUID containing "5000") |

## Identity

| | |
|---|---|
| Release commit | `f85288880ef01346b6c084f378af02a0f8cdc537` (`fleet-origin/fleet/final-v2.4`), tree `d5f659ac…` |
| Runtime build ID | `00f67293ae92240f91d8f571b13824fd33911b8526093092d37edf22d673e52c`; the VPS build and an independent local build agree |
| Lockfile SHA-256 | `1df54e3526cb39c847d18fec14f1d4e3595557e34d94040c5b774f9b2f2a21c1` (unchanged) |
| Pins file (VPS) | `~/rlc62b/pins.txt` |
| Dashboard | 0.13.0, `~/rlc62b/ui-0.13.0-f852888.tgz` (build VM copy: `/var/tmp/automaton-fleet-ui-build/`), live tree digest `299ac7f4…40cc`, 52 files; a second build is byte-identical |
| Dashboard SHA-256 | `27cfff7d0cf5ed1506fbaa93057216cb212b5cfda8ad20499d32401965756f6b` (verified on the VPS) |
| Release scripts | `~/rlc62b/fleet-{rollout,release,ui-deploy}.sh`, byte-identical to the commit (and unchanged since `~/rlc61`) |

## Validation (frozen trees; no edits during runs)

| Run | Tree | Result |
|---|---|---|
| `npx tsc --noEmit` | 3b456cd, f852888 | pass |
| security suite | 3b456cd | 1382 / 1386 (1 skipped); 3 failures, all fixed in f852888 (below) |
| financial suite | 3b456cd | 838 / 845 (1 skipped); 6 failures, all fixed in f852888 (below) |
| 18 focus files not covered by those suites (conversations runtime, labels, contract, cognition, dashboards, PayPal, mapping, …) | 3b456cd | 155 / 155 |
| dashboard typecheck, lint, simulation, live build | 3b456cd (no dashboard change since) | pass |
| delta after the fixes: founder-upgrade (real founder processes), event routing, live-01-pg, v56 / v57 / v59 routing, ledger, R41.1 continuation, founder conversation | f852888 | 112 / 112 (9 files) |

The 3b456cd failures and their fixes, with no check weakened:

- `fleet-founder-upgrade` (real processes). In the scripted model, the v5 close asked for seven tool calls; only five
  run per step. The declared sleep that was cut off still ended the turn, and v62 then correctly kept the founder
  hibernating, so its journal was never written and no slim wake-up followed. The scripted founder now closes the walk
  with a plain sleep and declares hibernation at its first slim wake-up, inside the limit. The rehearsal waits for the
  journal and the declared wake condition together. The checks are unchanged: 12/12.
- `fleet-event-routing-pg`: the routing-table test now includes the v62 routes.
- `fleet-live-01-pg`: its slim-packet rig sets `hibernationSafetyMs: 0` (timer backoff only), like the other rigs.
- v56 / v57 / v59 "events are routed": those kinds now route to `P3_SUMMARY` (the v62 fix).
- `fleet-ledger` circuit-breaker leak check: the order id `05000291-…` matched `/5000/`. UUIDs are masked before the check.

Evidence: `~/fleet-release-evidence/3b456cd/validation/` and `~/fleet-release-evidence/f852888/` on the build VM.

## Rehearsal (`fleet-rollout.sh rehearse ~/rlc62b/pins.txt 61 62`, 2026-10-10 15:25:35–15:25:55Z): PASSED

- Dump `~/automaton_fleet-v61-rollout-f852888-20261010T152539Z.dump` (`24222c43…`). Restore row counts identical;
  migrate-check would apply 62; counters consistent.
- Reconciliation OK: 0 new accounts; 804 journals; 1,646 events preserved, none purged; only role grants appended.
  Ledger verify true. A re-run applies nothing. Rollback proof: the dump restores to 61 with the same ledger head.
- Stamp `~/rollout-f852888-rehearsal.ok`. The cutover must start before **2026-10-11 15:25:55Z**, or rehearse again.
- Second disposable copy (`~/rlc62b/check62.sh`, copy dropped). These were **identical** before and after:
  - founders: status, registry name, identity hash, ledger fingerprint, cash 8,641 / 9,536;
  - settings: protection on, custody off, 1 rail, identity authority off, sweep off, registry 2/2;
  - PayPal: key `4fee40f2c10ba139`, sealed credential active, credential active, rail `pending_setup` with webhook
    `4JR443408B058674D`, 0 checks.

  The v62 tables on the migrated copy:
  - 0 messages and 0 labels;
  - names still shown as Agent-1 / Agent-2;
  - `owner_conversation_charge` registered;
  - the backfill run again returns 0;
  - each thread shows its one pending request, with the agent paused.

  The v61 owner-test gate stayed closed.
- Afterwards, live: schema 61, runtime b0ac910, both agents paused, flags false.

## Deployment (needs the owner's authorization, within the rehearsal window)

1. Controller and dashboard:
   ```
   bash ~/rlc62b/fleet-release.sh ~/rlc62b/pins.txt 61 62 0.13.0 ~/rlc62b/ui-0.13.0-f852888.tgz 27cfff7d0cf5ed1506fbaa93057216cb212b5cfda8ad20499d32401965756f6b
   ```
   Then run the usual read-only checks: founders' identity and ledger fingerprints against the pre-cutover baseline,
   flags, custody, protection and the PayPal state. With this step alone you get names, threads, sending messages and
   files (they wait as *pending*), answering requests, card approvals in the thread, and the P3 fix (see the spec's
   "what works when" table).
   Rollback: UI `dashboard.env.pre-0.13.0`, then `bash ~/rlc62b/fleet-rollout.sh revert ~/rlc62b/pins.txt 61 62 <reason>`.
2. Agents' runtime: conversations, `reply_to_owner` and event-driven hibernation need it. This step needs its own
   authorization and can run only after step 1, because it rehearses toward the installed release.
   ```
   sudo scripts/fleet-founders.sh upgrade-rehearsal fda78a0eeaa8af87bd8725b7bf1df0c1bea315db
   sudo scripts/fleet-founders.sh upgrade-preflight 01M4C4NXT786Q4E9725N5A15KV
   sudo scripts/fleet-founders.sh upgrade-runtime 01M4C4NXT786Q4E9725N5A15KV      # Agent-2 first
   sudo scripts/fleet-founders.sh upgrade-preflight 01M3F50SH7PNX2E3GST13J52AS
   sudo scripts/fleet-founders.sh upgrade-runtime 01M3F50SH7PNX2E3GST13J52AS      # then Agent-1
   ```
   Run these from `/opt/automaton-fleet/current`. Rollback: `rollback-runtime <agentId> <upgradeId> <reason>`.
3. Resuming the agents is a separate decision, with Pause / Resume on each conversation. Before that, the treasury must
   be able to pay for owner turns: it holds £0 outside the agents' partitions, so owner messages wait with "treasury
   short" until it is funded.

## Deployment (2026-10-10, owner-authorized): DEPLOYED

Pre-flight 16:06:32Z: pins, package `27cfff7d…`, scripts and build checkout matched; rehearsal stamp 15:25:55Z (valid);
production b0ac910 / 61 / UI 0.12.1, both agents paused, founder baseline taken.

- `fleet-release.sh` 16:06:44–16:08:28Z, exit 0; outage 16:07:34–16:08:17Z (43 s). Pre-migration dump
  `~/automaton_fleet-v61-pre-v62-20261010T160754Z.dump` (`a56d9fb2…`); migrate 62; reconciliation OK (1,655 events,
  none purged). UI 0.13.0 at `/opt/automaton-fleet/ui/0.13.0` (52 files), root verified, unauthenticated read 401; one
  `production_deployed`.
- Runtime f852888 / `00f67293…e52c`; `/opt/automaton-fleet/current` → f852888; the four flags false; protection on;
  custody execution off; identity authority off; sweep off; registry 2/2 DEVELOPMENT.
- Founders: identity hashes and ledger fingerprints identical to the 16:06:32Z baseline; 804 journals before and after;
  cash 8,641 / 9,536; both on fda78a0, units running, **both still paused**; no AI call since 12:19:54Z. Shown as
  Agent-1 / Agent-2; each thread shows its one pending request.
- PayPal unchanged: key `4fee40f2c10ba139`, sealed credential active, rail `pending_setup`, webhook `4JR443408B058674D`,
  0 checks. v62: 0 messages, `owner_conversation_charge` registered, ledger verify true.
- Events since the start: role grants, `runtime_approved`, `production_deployed`, one `session_opened`, the usual two
  restart-time `api_auth_failed` heartbeats. Public `/healthz` and `/v1/health` 200 (`/readyz` is loopback-only: 200).
- Rollback: UI `dashboard.env.pre-0.13.0`; backend `bash ~/rlc62b/fleet-rollout.sh revert ~/rlc62b/pins.txt 61 62 <reason>`.

Next, each on the owner's word: the agents' runtime upgrade (step 2 above), resuming them, and PayPal readiness.
